// Signs the updater bundle the way `tauri signer sign` does, with nothing but Node's own crypto,
// so the release job that holds the update key runs no npm package and no build script.
//
//   node scripts/updater-sign.ts <file> [--public-key <file.pub>]
//   node scripts/updater-sign.ts <file> --check [--manifest <latest.json>] [--public-key <file.pub>]
//
// The second form signs nothing and needs no key: it checks <file>.sig, and the signature the
// manifest hands installed copies, the way an installed copy checks them. The release gate runs it.
//
// Environment:
//   TAURI_SIGNING_PRIVATE_KEY           the key as `tauri signer generate` wrote it: the file's
//                                       contents, or a path to the file
//   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  its password, empty for none
//
// The signature is checked before it is written, against the public key every installed copy
// holds (plugins.updater.pubkey in src-tauri/tauri.conf.json), or against --public-key for a
// throwaway key. A wrong password, or a key installed copies do not trust, writes nothing and
// exits non-zero.
//
// The format is minisign's, which tauri-plugin-updater checks with the minisign-verify crate:
//
//   key        base64 of "untrusted comment: ...\n" and base64 of: "Ed" "Sc" "B2", a 32-byte salt,
//              scrypt's opslimit and memlimit (u64 little-endian), then 104 bytes (key id, the
//              64-byte Ed25519 secret key, a checksum) XORed with scrypt(password, salt)
//   signature  base64 of "untrusted comment: ...\n", base64("ED", key id, Ed25519 over the file's
//              BLAKE2b-512), "\ntrusted comment: timestamp:<unix>\tfile:<name>\n", and base64 of
//              Ed25519 over that signature and the comment, then a line break
//
// Node's Ed25519 is the deterministic one (RFC 8032). Tauri's signer mixes in random noise, so
// the two sign one file with different bytes, and both verify. The pure parts are exported for
// tests/unit/updater-sign.test.ts and for the plugin's own verifier in src-tauri/src/update.rs.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type SecretKey = { keyId: Buffer; seed: Buffer; publicKey: Buffer };

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const UNTRUSTED = 'untrusted comment: signature from tauri secret key';
const TRUSTED = 'trusted comment: ';

/* How libsodium's crypto_pwhash_scryptsalsa208sha256 turns the two limits a minisign key stores
   into scrypt's N, r and p (pickparams in pwhash_scryptsalsa208sha256.c). */
export function scryptParams(opslimit: number, memlimit: number): { N: number; r: number; p: number } {
  const ops = Math.max(opslimit, 32768);
  const r = 8;
  const maxN = ops < Math.floor(memlimit / 32) ? Math.floor(ops / (r * 4)) : Math.floor(memlimit / (r * 128));
  let logN = 1;
  while (logN < 63 && 2 ** logN <= Math.floor(maxN / 2)) logN += 1;
  if (ops < Math.floor(memlimit / 32)) return { N: 2 ** logN, r, p: 1 };
  const maxrp = Math.min(Math.floor(Math.floor(ops / 4) / 2 ** logN), 0x3fffffff);
  return { N: 2 ** logN, r, p: Math.floor(maxrp / r) };
}

function privateKey(seed: Buffer): crypto.KeyObject {
  const der = Buffer.concat([PKCS8_ED25519, seed]);
  try {
    return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } finally {
    der.fill(0);
  }
}

function publicKeyObject(raw: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
}

/* Tauri takes the key file's contents or a path to the file, and the contents are base64 of
   the key's text. */
function keyText(raw: string): string {
  const value = raw.trim();
  const contents = !value.includes('\n') && fs.existsSync(value) ? fs.readFileSync(value, 'utf8').trim() : value;
  return contents.startsWith('untrusted comment:') ? contents : Buffer.from(contents, 'base64').toString('utf8');
}

/* Opens the key with its password. The checksum inside is BLAKE2b-256, which Node does not
   offer, so the proof that the password was right is the public key: the one the opened secret
   key derives must be the one stored beside it. */
export function decodeSecretKey(raw: string, password: string): SecretKey {
  const blob = Buffer.from(keyText(raw).split('\n')[1] ?? '', 'base64');
  if (blob.length !== 158 || blob.toString('latin1', 0, 6) !== 'EdScB2') {
    throw new Error('updater-sign: TAURI_SIGNING_PRIVATE_KEY is not a password-protected minisign key as tauri writes one');
  }
  const { N, r, p } = scryptParams(Number(blob.readBigUInt64LE(38)), Number(blob.readBigUInt64LE(46)));
  const stream = crypto.scryptSync(Buffer.from(password, 'utf8'), blob.subarray(6, 38), 104, { N, r, p, maxmem: 2 * 128 * N * r * p });
  const opened = Buffer.alloc(104);
  for (let i = 0; i < 104; i += 1) opened[i] = blob[54 + i] ^ stream[i];
  stream.fill(0);
  const keyId = Buffer.from(opened.subarray(0, 8));
  const seed = Buffer.from(opened.subarray(8, 40));
  const stored = Buffer.from(opened.subarray(40, 72));
  opened.fill(0);
  const publicKey = crypto.createPublicKey(privateKey(seed)).export({ format: 'der', type: 'spki' }).subarray(-32);
  if (!publicKey.equals(stored)) {
    seed.fill(0);
    throw new Error('updater-sign: the key did not open: the password is wrong or the key is damaged');
  }
  return { keyId, seed, publicKey: Buffer.from(publicKey) };
}

/* The .sig file's contents for `data`. */
export function signFile(data: Buffer, key: SecretKey, trustedComment: string): string {
  const signer = privateKey(key.seed);
  const signature = crypto.sign(null, crypto.createHash('blake2b512').update(data).digest(), signer);
  const global = crypto.sign(null, Buffer.concat([signature, Buffer.from(trustedComment, 'utf8')]), signer);
  const line = Buffer.concat([Buffer.from('ED', 'latin1'), key.keyId, signature]).toString('base64');
  const text = `${UNTRUSTED}\n${line}\n${TRUSTED}${trustedComment}\n${global.toString('base64')}\n`;
  return Buffer.from(text, 'utf8').toString('base64');
}

/* What the updater plugin checks (minisign-verify, legacy signatures allowed), on a .sig file's
   contents and a public key as tauri.conf.json holds it: both base64 of their text. */
export function verifyFile(data: Buffer, sig: string, pub: string): boolean {
  const pk = Buffer.from(Buffer.from(pub.trim(), 'base64').toString('utf8').trim().split('\n')[1] ?? '', 'base64');
  const lines = Buffer.from(sig.trim(), 'base64').toString('utf8').split('\n');
  const head = Buffer.from(lines[1] ?? '', 'base64');
  const comment = lines[2] ?? '';
  const global = Buffer.from(lines[3] ?? '', 'base64');
  if (pk.length !== 42 || head.length !== 74 || global.length !== 64 || !comment.startsWith(TRUSTED)) return false;
  if (pk.toString('latin1', 0, 2) !== 'Ed' || !pk.subarray(2, 10).equals(head.subarray(2, 10))) return false;
  const algorithm = head.toString('latin1', 0, 2);
  if (algorithm !== 'ED' && algorithm !== 'Ed') return false;
  const key = publicKeyObject(pk.subarray(10));
  const signature = head.subarray(10);
  const signed = algorithm === 'ED' ? crypto.createHash('blake2b512').update(data).digest() : data;
  if (!crypto.verify(null, signed, key, signature)) return false;
  return crypto.verify(null, Buffer.concat([signature, Buffer.from(comment.slice(TRUSTED.length), 'utf8')]), key, global);
}

/* The key id the way minisign prints it, which is how the public key's comment names it: the
   little-endian u64 in upper-case hex with no leading zeros, so one id in 16 has 15 digits. */
export function keyIdHex(keyId: Buffer): string {
  return keyId.readBigUInt64LE(0).toString(16).toUpperCase();
}

function shippedPublicKey(): string {
  const conf = JSON.parse(fs.readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const pub = conf?.plugins?.updater?.pubkey;
  if (typeof pub !== 'string' || pub === '') throw new Error('updater-sign: src-tauri/tauri.conf.json carries no plugins.updater.pubkey');
  return pub;
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

function main(): void {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) throw new Error('usage: node scripts/updater-sign.ts <file> [--check [--manifest <latest.json>]] [--public-key <file.pub>]');
  const publicKeyFile = option('--public-key');
  const against = publicKeyFile ?? 'the public key in src-tauri/tauri.conf.json';
  const pub = publicKeyFile ? fs.readFileSync(publicKeyFile, 'utf8') : shippedPublicKey();

  if (process.argv.includes('--check')) {
    const data = fs.readFileSync(file);
    const sigs: [string, string][] = [[`${path.basename(file)}.sig`, fs.readFileSync(`${file}.sig`, 'utf8')]];
    const manifest = option('--manifest');
    if (manifest) {
      const platforms = JSON.parse(fs.readFileSync(manifest, 'utf8'))?.platforms ?? {};
      for (const [platform, entry] of Object.entries(platforms)) sigs.push([`${path.basename(manifest)} ${platform}`, String((entry as { signature?: unknown }).signature ?? '')]);
      if (sigs.length === 1) throw new Error(`updater-sign: ${manifest} names no platform`);
    }
    for (const [name, sig] of sigs) {
      if (!verifyFile(data, sig, pub)) throw new Error(`updater-sign: the signature in ${name} does not verify ${path.basename(file)} against ${against}`);
      console.log(`updater-sign: the signature in ${name} verifies ${path.basename(file)} against ${against}`);
    }
    return;
  }

  const raw = process.env.TAURI_SIGNING_PRIVATE_KEY ?? '';
  if (raw.trim() === '') throw new Error('updater-sign: TAURI_SIGNING_PRIVATE_KEY is not set; an unsigned update would be refused by every installed copy');
  const key = decodeSecretKey(raw, process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '');
  const data = fs.readFileSync(file);
  const sig = signFile(data, key, `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${path.basename(file)}`);
  key.seed.fill(0);
  if (!verifyFile(data, sig, pub)) {
    throw new Error(`updater-sign: the signature does not verify against ${against}, so this is not the key installed copies trust; nothing was written`);
  }
  fs.writeFileSync(`${file}.sig`, sig);
  console.log(`updater-sign: ${path.basename(file)}.sig verifies against ${against} (key ${keyIdHex(key.keyId)})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
