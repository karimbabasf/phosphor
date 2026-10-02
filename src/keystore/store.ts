// The keystore: one encrypted file, one unlocked handle, and the four things that produce it
// (create, import, migrate, unlock).
//
// THE FILE. `keys.enc.json` sits beside where `keys.json` lived, at 0600, and holds four
// parts: a plaintext header, the data key wrapped under the password, the payload encrypted
// under the data key, and a proof of the header's addresses under the same password.
//
// THE HEADER IS NOT A SOURCE OF TRUTH, and treating it as one cost this app its worst bug. It
// is the additional authenticated data for both envelopes, so an edit to it does break the tag
// -- on the next unlock, which is the only place the tag is ever checked. Until then it is a
// plaintext field any process running as the owner can rewrite, and every read path used to
// serve the addresses in it as fact, locked or unlocked. Swapping the EVM address there was a
// one-line edit that pointed the Money-in screen at somebody else's wallet, with no password
// and no window token, and the only signal was a later unlock reporting a wrong password. So:
// once this process has opened the wallet it serves the addresses it DERIVED and never the
// header's, a header it has not opened is served marked unverified, and a header a correct
// password proves was edited is served not at all. See addressReport().
//
// WHAT LOCKED MEANS. Locked is not "the app stops". Every read works, because addresses come
// from the header, or better from the last open. Every write proposal is still authored and
// policy-checked and queued; see pending_unlock in src/proposals/lifecycle.ts. What locked
// removes is the ability to SIGN.
//
// THE PLAINTEXT FALLBACK, and it is deliberate. An install that has a `keys.json` and has not
// migrated yet keeps working: state() reports `needs_migration` and the readers below fall
// back to that file. Refusing instead would mean the upgrade that adds custody is the upgrade
// that breaks the wallet, and the migration would be forced rather than verified. It is one
// function, named, and it is the only place in the app that opens a plaintext key file.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { aadFor, canonical, newDataKey, open, seal, wipe } from './envelope.ts';
import type { Sealed } from './envelope.ts';
import { defaultParams, deriveKek } from './kdf.ts';
import type { KdfParams } from './kdf.ts';
import { addressesFromKeys, newWallet, normaliseMnemonic, walletFromMnemonic } from './derive.ts';
import type { RailKeys, Wallet } from './derive.ts';
import { seWrap } from './sewrap.ts';
import type { SeWrapped } from './sewrap.ts';
import { atomicWrite } from '../fsatomic.ts';

export const KEYSTORE_FILENAME = 'keys.enc.json';

// Five failures, then thirty seconds. Not a lockout an attacker can trigger against the owner
// (it is a local file behind a window token) and not a defence against an offline attack
// either, which the KDF answers. It is what stops a script from grinding a weak password
// through the HTTP route at the speed of the event loop.
const MAX_FAILURES = 5;
const BACKOFF_MS = 30_000;
/* How long a move already on its way may keep the key, after the wallet was told to lock, to
   reach its signature: the quote, the checks and the reads a rail makes before it signs, each on
   its own network timeout. Past it the key goes anyway, and a rail that had not signed yet fails
   with the wallet locked and nothing signed. */
export const CLOSE_GRACE_MS = 2 * 60_000;
const CLOSE_SWEEP_MS = 250;

const EVM_KEY = /^0x[0-9a-fA-F]{64}$/;

/* DEMO MODE NEVER DESTROYS A KEY FILE, and this is the second lock on a door the config file
   already shut. The first lock is that a demo boot resolves its own key file and never the real
   one: inside the data directory it was given, or in ~/.phosphor-demo when that directory is
   the repo default, and never in ~/.phosphor whatever PHOSPHOR_APP_DATA says (config.ts
   defaultKeysPath). This one holds even when a demo process is pointed at a real key file by
   hand, which PHOSPHOR_KEYS still allows on purpose: migration shreds
   the plaintext file AND every backup beside it, and that is not something a throwaway
   instance may ever do.
   The mode is read from the environment here because destroyPlaintext is a free function with
   no config in reach. createKeystore is told the mode outright, so a demo set in config.json
   rather than in the environment is covered too. */
const DEMO_REFUSAL =
  'demo mode never migrates a wallet, because migrating destroys the plaintext key file and every backup beside it. Start Phosphor in live mode to do this.';

function envIsDemo(): boolean {
  const mode = process.env.PHOSPHOR_MODE ?? process.env.ACC_MODE;
  return mode === 'demo';
}

export type LockState = 'unlocked' | 'locked' | 'no_wallet' | 'needs_migration';

export type AgentEntry = { privateKey?: string; address?: string; name?: string; approvedAt?: string };

/* What the file decrypts to. Deliberately the same shape as the plaintext keys.json it
   replaces: migration is then a copy rather than a translation, and every reader that already
   knew this shape still does. */
export type KeysPayload = {
  mnemonic?: string;
  evm?: { privateKey?: string; address?: string };
  solana?: { address?: string; secretKey?: string };
  near?: { accountId?: string; publicKey?: string; secretKey?: string };
  hyperliquidAgent?: AgentEntry;
  hyperliquidAgents?: { mainnet?: AgentEntry; [k: string]: AgentEntry | undefined };
  [k: string]: unknown;
};

export type StoredAddresses = { evm: string | null; solana: string | null; near: string | null; nearPublicKey: string | null };

/* The Hyperliquid API wallet the runner signs orders with: a key that can trade and, by the
   venue's own signing split, cannot withdraw, transfer or approve another agent. */
export type ApiWallet = { key: `0x${string}`; address: string | null };

/* Which entry in a payload is the API wallet. A keys.json written before 2026-09-01 keyed the
   agent by a venue axis this app no longer has, so the entry that names this venue wins and the
   flat field an older file carries is the fallback: no install loses its agent to a shape
   change. Nothing here writes the payload back or removes anything from it; it is key material,
   and a human removes what a human put there. */
export function apiWalletOf(payload: KeysPayload): ApiWallet | null {
  for (const entry of [payload.hyperliquidAgents?.mainnet, payload.hyperliquidAgent]) {
    const key = entry?.privateKey;
    if (typeof key === 'string' && EVM_KEY.test(key)) return { key: key as `0x${string}`, address: entry?.address ?? null };
  }
  return null;
}

/* The Secure Enclave key a version 2 file is wrapped to. `keyBlob` is the enclave's own opaque
   representation of the private key (CryptoKit dataRepresentation): useless off this Mac, and
   usable on it only after the owner's Touch ID. `publicKey` is X9.63, the half the wrap needs. */
export type EnclaveRef = { keyBlob: string; publicKey: string; createdAt: string };

/* 'software' is the scrypt password file (version 1). Named for what holds the key rather than
   for what opens it, and not 'password', because the state payload is grepped for that word by
   a test that guards against key material leaking, and a custody kind is not key material. */
export type Custody = 'software' | 'secure-enclave';

export type KeystoreHeader = {
  version: 1 | 2;
  createdAt: string;
  // Version 1 only: the scrypt parameters the password is stretched with. A version 2 file has
  // no password and no KDF, so the field is absent rather than filled with a decoy.
  kdf?: KdfParams;
  addresses: StoredAddresses;
  // Whether the payload carries twelve words. A wallet imported from three raw keys has none,
  // and the window must not offer to show a phrase that does not exist.
  hasMnemonic: boolean;
  // Absent on a version 1 file, which is a password file by construction.
  custody?: Custody;
  enclave?: EnclaveRef;
};

/* `headerProof` is what lets a failed unlock say WHY it failed, and it is additive: a file
   written before it existed simply has none and behaves exactly as it always did.

   The problem it solves. The header is the AAD for both envelopes, so editing the addresses in
   it breaks the wrap's tag. Good. What is not good is what the owner is then told: the wrap is
   opened first and a wrap that fails has always been reported as a wrong password, so somebody
   who had just had their receive address swapped was sent off to retype a password that was
   right all along.

   The proof is the same addresses sealed under the SAME password-derived key, with an AAD that
   covers every header field EXCEPT the addresses. So when the wrap fails, opening the proof
   answers "was the password right": if it opens, the password is right and the addresses in the
   header are not the ones this file was written with. That is a tamper, and it is named. */
/* VERSION 2 IS THE ENCLAVE FILE, and it is simpler than version 1 on purpose. The data key is
   wrapped to the enclave's public key (src/keystore/sewrap.ts) instead of under a password, the
   AAD of both envelopes is the header WITHOUT its addresses, and there is no headerProof:
   version 1 needed one to tell "wrong password" from "edited header", and version 2 has no
   password to be wrong. An edited address in a version 2 header leaves the envelopes openable,
   and the open then compares the addresses it derived with the ones the header claims, which is
   a sharper tamper signal than a failed tag: it says which file was edited and serves only the
   derived addresses from then on. */
type KeystoreFile = { header: KeystoreHeader; wrap: Sealed | SeWrapped; payload: Sealed; headerProof?: Sealed };

export type UnlockResult =
  | { ok: true }
  | {
      ok: false;
      error: 'wrong_password' | 'no_wallet' | 'damaged' | 'locked_out' | 'tampered' | 'enclave_required';
      retryInSec?: number;
      detail?: string;
    };

/* What the shell's relay needs to ask the enclave to unwrap this wallet: the key blob, the wrap,
   and the AAD the wrap was sealed under. All of it is on disk already; none of it opens anything
   without the enclave and the owner. */
export type EnclaveUnwrapRequest = { keyBlob: string; ephemeralPublicKey: string; ciphertext: string; aad: string };

/* The addresses plus how much they can be believed, which is a different fact and used to be
   silently missing.

   `verified` means these came out of key material this process decrypted, so nobody can have
   edited them. It is false for addresses read from the plaintext header of a locked wallet that
   this process has never opened: nothing authenticates that header without the password, and a
   screen that says "send money here" has to say which of the two it is showing.

   `tampered` means a password that opens this file proved the header's addresses are not the
   ones it was written with. No address is served in that state. */
export type AddressReport = { addresses: StoredAddresses; verified: boolean; tampered: boolean };

export type Keystore = {
  state(): LockState;
  // Open, and not closing: what a route that serves the person an open wallet asks.
  isUnlocked(): boolean;
  // Whether a signer can read its key right now: open, or closing behind signatures still under
  // way (lockWhen). Never the test for starting something new; isUnlocked() and state() are.
  keyHeld(): boolean;
  /* Lock once `done` says the signatures it waits for are made, and no later than `capMs` from
     now; the state reads locked from this call on. Keyed so a repeated ask is one closer. False
     when nothing is open. */
  lockWhen(key: string, done: () => boolean, capMs: number): boolean;
  addresses(): StoredAddresses;
  // The same addresses with the two facts a display needs beside them. Every route that puts an
  // address in front of a person reads this one; addresses() stays for the signers and readers
  // that only need the string.
  addressReport(): AddressReport;
  header(): KeystoreHeader | null;
  unlock(password: string): Promise<UnlockResult>;
  // Proves a password against the file and changes nothing. What a route that re-asks for the
  // password needs, as opposed to a route that opens the wallet.
  verify(password: string): Promise<UnlockResult>;
  lock(): boolean;
  create(password: string): Promise<{ mnemonic: string; addresses: StoredAddresses }>;
  importWallet(password: string, from: { mnemonic?: string; keys?: Partial<RailKeys> }): Promise<{ addresses: StoredAddresses }>;
  migrate(password: string): Promise<{ destroyed: string[]; addresses: StoredAddresses }>;
  exportTo(target: string, password: string): Promise<void>;
  // Unlocked only, and the one path key material leaves this module by.
  reveal(): { mnemonic: string | null; keys: KeysPayload };
  // Throws when locked. Every signer goes through this or through the helpers below it.
  keys(): KeysPayload;
  // The EVM private key and nothing else, which is all an EVM signature needs. Throws when locked,
  // as keys() does, and never decodes the rest of the payload: see `evmKey` in createKeystore.
  evmPrivateKey(): `0x${string}`;
  // The same for the runner: the API wallet alone, or null when the wallet has none. See `apiKey`.
  apiWallet(): ApiWallet | null;
  path(): string;
  onChange(fn: (state: LockState) => void): () => void;

  // ---- the enclave half: version 2 files ----
  // Which kind of file is on disk. Null when there is no wallet.
  custody(): Custody | null;
  // The enclave key this file is wrapped to, or null for a password file.
  enclave(): EnclaveRef | null;
  // What to hand the shell so the enclave can unwrap the data key. Null for a password file.
  enclaveRequest(): EnclaveUnwrapRequest | null;
  // The version 2 unlock: the data key came back from the enclave, open the payload with it.
  // Wipes the buffer it is given either way.
  unlockWithDataKey(dek: Buffer): UnlockResult;
  /* The payload opened for one read and wiped, under a data key or a password, with the lock
     state exactly as it was: what a touch or a password asked for something other than opening
     the wallet (showing an address, revealing the phrase) gets. The data key is wiped either way. */
  readWithDataKey<T>(dek: Buffer, read: (payload: KeysPayload) => T): { ok: true; value: T } | Extract<UnlockResult, { ok: false }>;
  readWithPassword<T>(password: string, read: (payload: KeysPayload) => T): Promise<{ ok: true; value: T } | Extract<UnlockResult, { ok: false }>>;
  /* An approval's Touch ID: the wallet is opened for one move and stays locked to everything else
     (lockWhen under `key`), or, when it is already open, the touch is only proved. */
  openFor(key: string, dek: Buffer, done: () => boolean, capMs: number): UnlockResult;
  createWithEnclave(enclave: EnclaveRef): { addresses: StoredAddresses };
  importWithEnclave(enclave: EnclaveRef, from: { mnemonic?: string; keys?: Partial<RailKeys> }): { addresses: StoredAddresses };
  // A version 1 file becomes a version 2 file: the password opens it once, a fresh data key is
  // wrapped to the enclave, and the password wrap is gone from disk.
  rewrapToEnclave(password: string, enclave: EnclaveRef): Promise<UnlockResult>;
  // Rewrites the payload under the open wallet's data key, for the one legitimate reason the
  // payload changes: a Hyperliquid API wallet was added or revoked. Version 2 and unlocked only.
  updatePayload(mutate: (payload: KeysPayload) => KeysPayload): StoredAddresses;
  // Shreds the file. The caller has already made the person prove they mean it.
  forget(): { destroyed: string };
};

// ---------- files ----------

export function keystorePathFor(keysPath: string): string {
  return path.join(path.dirname(keysPath), KEYSTORE_FILENAME);
}

/* tmp-then-rename with the tmp file's contents forced to disk first, so a crash leaves either
   the old file or the new one and never half of one.

   Through src/fsatomic.ts now. This held its own copy while the custody and reliability tracks
   were in flight, on the stated ground that a key file must not wait on another branch to be
   written safely, and the copy was very nearly right: what it did not do was fsync the DIRECTORY
   after the rename, so the entry naming the new key file could be lost in the same power cut it
   was guarding against. One writer, one place that gets that right.

   `ownDir` is false for an export, which lands wherever the person chose. Tightening the mode of
   the app's own key directory is right; tightening the mode of somebody's Documents folder is
   not ours to do, and on a shared temp directory it is not even permitted. */
function writeSecret(target: string, body: string, ownDir = true): void {
  atomicWrite(target, body, { mode: 0o600, ...(ownDir ? { dirMode: 0o700 } : {}) });
}

function readKeystoreFile(file: string): KeystoreFile | null {
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as KeystoreFile;
  if (parsed.header?.version !== 1 && parsed.header?.version !== 2) {
    throw new Error(`${file} is not a keystore this app knows how to open`);
  }
  return parsed;
}

/* The header alone, with no password. This is what makes a locked app useful: the addresses
   every balance read needs are here, in the clear.

   NOT AUTHENTICATED, and this comment used to claim it was. The tag on the payload does bind the
   header, because the header is the AAD, but that tag is only ever checked inside openWith, and
   openWith needs the password. So a header read by this function is a header nobody has checked:
   any process running as the owner can edit the addresses in it, and every reader downstream
   used to serve the result as fact. Callers that show an address to a person go through
   addressReport() instead, which says whether the addresses were decrypted or merely read. */
export function readHeader(keysPath: string): KeystoreHeader | null {
  const file = keystorePathFor(keysPath);
  try {
    return readKeystoreFile(file)?.header ?? null;
  } catch {
    return null;
  }
}

function addressesOf(keys: KeysPayload): StoredAddresses {
  const derived = addressesFromKeys({
    evm: keys.evm?.privateKey as `0x${string}` | undefined,
    solana: keys.solana?.secretKey,
    nearSecret: keys.near?.secretKey,
  });
  return {
    evm: derived.evm ?? keys.evm?.address ?? null,
    solana: derived.solana ?? keys.solana?.address ?? null,
    near: derived.near ?? keys.near?.accountId ?? null,
    nearPublicKey: derived.nearPublicKey ?? keys.near?.publicKey ?? null,
  };
}

const NO_ADDRESSES: StoredAddresses = { evm: null, solana: null, near: null, nearPublicKey: null };

/* The AAD for the header proof: every header field except the addresses. Excluding them is the
   whole point, because the proof has to stay openable on the one file where the addresses have
   been changed. Everything else the header carries (the version, the KDF parameters and whether
   there is a mnemonic) is still covered, so a downgrade of any of those breaks the proof too and
   reads as a wrong password, which is the fail-closed answer. */
function proofAad(header: KeystoreHeader): Buffer {
  const { addresses: _addresses, ...rest } = header;
  return aadFor(rest);
}

function isEnclaveFile(stored: KeystoreFile): boolean {
  return stored.header.version === 2 && stored.header.custody === 'secure-enclave' && stored.header.enclave !== undefined;
}

function sameAddresses(a: StoredAddresses, b: StoredAddresses): boolean {
  return canonical(a) === canonical(b);
}

// One key. A new payload carries no Solana or NEAR key (see derive.ts for why); only a file
// written before 0.10.5 still holds them, and it keeps them untouched.
function payloadFrom(mnemonic: string | null, keys: Wallet['keys'], addresses: Wallet['addresses']): KeysPayload {
  return {
    ...(mnemonic !== null ? { mnemonic } : {}),
    evm: { address: addresses.evm, privateKey: keys.evm },
  };
}

// ---------- the store ----------

export function createKeystore(opts: { keysPath: string; mode?: string; now?: () => number; kdf?: () => KdfParams }): Keystore {
  const keysPath = opts.keysPath;
  const file = keystorePathFor(keysPath);
  const now = opts.now ?? Date.now;
  const demo = opts.mode === 'demo' || envIsDemo();
  /* The parameters a NEW file is written with. Injected only so the test suite can run the
     same code at a cost that is not 256 MiB and half a second per case; src/main.ts never
     passes it, and an existing file is always opened with the parameters in its own header. */
  const params = opts.kdf ?? defaultParams;
  const listeners = new Set<(state: LockState) => void>();

  // The unlocked payload, held as bytes so it can be erased. A parsed object would spread the
  // key across immutable strings the garbage collector copies and nothing can overwrite.
  let plain: Buffer | null = null;
  /* The data key of an OPEN version 2 wallet, kept beside the payload so the payload can be
     rewritten (an API wallet added) without a second Touch ID. It is no more than the payload
     already is, it is wiped by the same lock, and a version 1 wallet never sets it. */
  let dataKey: Buffer | null = null;
  /* THE ONE KEY A SIGNATURE NEEDS, as its 32 bytes, set and wiped with the payload by hold() and
     lock(). keys() decodes the WHOLE payload into a string and parses it, the recovery phrase and
     every other key included, and every EVM signature used to go through it: each one left
     another copy of the phrase in heap that nothing can overwrite, still there after a lock until
     the allocator happens to reuse the memory. A signer reads this instead. The key still becomes
     a hex string for viem and a bigint inside noble, and JavaScript can wipe neither, so a
     signature still leaves the EVM key behind. It no longer leaves the phrase. */
  let evmKey: Buffer | null = null;
  // The runner's key, kept the same way for the same reason: every runner it starts reads it.
  let apiKey: Buffer | null = null;
  let apiAddress: string | null = null;
  let failures = 0;
  let backoffUntil = 0;
  /* The addresses this process has DECRYPTED, which is the only version of them worth serving.
     Kept after a lock on purpose: they are public data, they cannot go stale (this app has no
     path that changes a wallet's keys), and keeping them means the receive screen after a
     fifteen-minute auto-lock still shows the address the wallet actually holds rather than
     whatever the file says by then. Null only until the first open. */
  let openAddresses: StoredAddresses | null = null;
  // Set when a correct password proved the header's addresses are not the ones this file was
  // written with. From then on this store serves no address at all.
  let tampered = false;
  /* SHUT TO EVERYTHING NEW, OPEN TO WHAT IS ALREADY SIGNING. A closer keeps the payload held
     after the wallet has been told to lock, until its `done` says the signatures it waits for are
     made, or its cap runs out. state() says locked from the first closer on, so nothing new starts
     (land, approve and a held retry all ask isLocked(), and no plan re-arms: that only follows an
     announced unlock), while a signer already under way still reads its key. lock() is the end of
     it, whoever calls it. See lockWhen. */
  type Closer = { done: () => boolean; until: number };
  const closers = new Map<string, Closer>();
  let closeTimer: NodeJS.Timeout | null = null;

  function announce(): void {
    const s = state();
    for (const fn of listeners) fn(s);
  }

  function hasKeystore(): boolean {
    return fs.existsSync(file);
  }

  function state(): LockState {
    if (plain !== null) return closers.size === 0 ? 'unlocked' : 'locked';
    if (hasKeystore()) return 'locked';
    if (fs.existsSync(keysPath)) return 'needs_migration';
    return 'no_wallet';
  }

  /* WHERE THE RECEIVE ADDRESS COMES FROM, in order of how much it can be believed.

     This used to be one line: return the header's addresses. The header is plaintext and nothing
     checks it without the password, so any process running as the owner could edit one field of
     one file and the Money-in screen would hand out an address it controls, locked or unlocked,
     with no password and no window token. Everything sent to the wallet after that is gone, and
     the only signal was a later unlock reporting a wrong password.

     So: what was decrypted beats what was read, and a file known to have been edited serves
     nothing at all. */
  function addressReport(): AddressReport {
    /* Tampered with the true addresses in hand (a version 2 open compared them) serves the true
       ones and says the file was edited; tampered without them (a version 1 proof, no payload)
       serves nothing. Both say tampered, because the window has to. */
    if (tampered) {
      return openAddresses !== null
        ? { addresses: openAddresses, verified: true, tampered: true }
        : { addresses: NO_ADDRESSES, verified: false, tampered: true };
    }
    if (openAddresses !== null) return { addresses: openAddresses, verified: true, tampered: false };

    // Before migration the addresses come from the plaintext file, which is the only place
    // they exist yet. Same answer, worse storage, and the migration screen says so. Derived
    // from the keys in it rather than copied out of it, so they are as good as an unlock.
    if (plain === null && !hasKeystore() && fs.existsSync(keysPath)) {
      try {
        return { addresses: addressesOf(JSON.parse(fs.readFileSync(keysPath, 'utf8')) as KeysPayload), verified: true, tampered: false };
      } catch {
        return { addresses: NO_ADDRESSES, verified: false, tampered: false };
      }
    }

    /* A locked wallet this process has never opened. The header is all there is, and nothing
       authenticates it, so it is served with verified: false rather than as fact. The window
       says so, and one unlock replaces it with the decrypted answer. */
    const head = readHeader(keysPath);
    if (head !== null) return { addresses: head.addresses, verified: false, tampered: false };
    return { addresses: NO_ADDRESSES, verified: false, tampered: false };
  }

  function addresses(): StoredAddresses {
    return addressReport().addresses;
  }

  function keys(): KeysPayload {
    if (plain !== null) return JSON.parse(plain.toString('utf8')) as KeysPayload;
    if (hasKeystore()) throw new Error('the wallet is locked: unlock it in the app window to sign anything');
    if (fs.existsSync(keysPath)) return JSON.parse(fs.readFileSync(keysPath, 'utf8')) as KeysPayload;
    throw new Error(`no wallet yet. Create one in the app window, or point PHOSPHOR_KEYS at an existing ${path.basename(keysPath)}`);
  }

  function evmPrivateKey(): `0x${string}` {
    if (plain !== null) {
      if (evmKey === null) throw new Error('this wallet has no valid EVM private key');
      return `0x${evmKey.toString('hex')}`;
    }
    // Locked, or not migrated yet: keys() throws for the first and reads keys.json for the second.
    const key = keys().evm?.privateKey;
    if (typeof key !== 'string' || !EVM_KEY.test(key)) throw new Error('this wallet has no valid EVM private key');
    return key as `0x${string}`;
  }

  function apiWallet(): ApiWallet | null {
    if (plain !== null) return apiKey === null ? null : { key: `0x${apiKey.toString('hex')}`, address: apiAddress };
    return apiWalletOf(keys());
  }

  // Every way the payload comes open lands here, so the keys beside it are never stale and never
  // outlive it. An open is an open: a lock still waiting on its closers is called off.
  function hold(body: Buffer, payload: KeysPayload): void {
    stopClosing();
    if (plain !== null && plain !== body) wipe(plain);
    wipe(evmKey, apiKey);
    plain = body;
    const key = payload.evm?.privateKey;
    evmKey = typeof key === 'string' && EVM_KEY.test(key) ? Buffer.from(key.slice(2), 'hex') : null;
    const api = apiWalletOf(payload);
    apiKey = api === null ? null : Buffer.from(api.key.slice(2), 'hex');
    apiAddress = api?.address ?? null;
  }

  async function write(password: string, payload: KeysPayload, kdf: KdfParams): Promise<StoredAddresses> {
    const header: KeystoreHeader = {
      version: 1,
      createdAt: new Date(now()).toISOString(),
      kdf,
      addresses: addressesOf(payload),
      hasMnemonic: typeof payload.mnemonic === 'string' && payload.mnemonic.length > 0,
    };
    const aad = aadFor(header);
    const dataKey = newDataKey();
    const kek = await deriveKek(password, kdf);
    try {
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      const sealedPayload = seal(body, dataKey, aad);
      const wrap = seal(dataKey, kek, aad);
      const headerProof = seal(Buffer.from(canonical(header.addresses), 'utf8'), kek, proofAad(header));
      writeSecret(file, JSON.stringify({ header, wrap, payload: sealedPayload, headerProof }, null, 2) + '\n');
      wipe(body);
      return header.addresses;
    } finally {
      wipe(dataKey, kek);
    }
  }

  /* The decrypt, and NOTHING ELSE. It reads the file, derives the key, opens both envelopes and
     hands back the payload bytes; whether the wallet ends up open is the caller's decision.
     Split out because two routes need to prove a password without opening anything. Backup and
     reveal both re-ask for the password, which is the control that stops an unattended open
     window being a key dump, and both used to run that check by calling unlock(). That is a real
     unlock, and export then announced nothing: the window kept drawing the lock screen, the idle
     timer kept counting from the last human action, and anything in pending_unlock stayed queued
     until somebody locked and unlocked again.
     The failure counter and the backoff belong here rather than in unlock, because they are the
     brute-force control and a route that checks a password is a route that can be ground. */
  async function openOnce(password: string): Promise<{ ok: true; body: Buffer } | Extract<UnlockResult, { ok: false }>> {
    if (now() < backoffUntil) {
      return { ok: false, error: 'locked_out', retryInSec: Math.ceil((backoffUntil - now()) / 1000) };
    }
    let stored: KeystoreFile | null;
    try {
      stored = readKeystoreFile(file);
    } catch (err) {
      return { ok: false, error: 'damaged', detail: err instanceof Error ? err.message : String(err) };
    }
    if (stored === null) return { ok: false, error: 'no_wallet' };
    // A version 2 file has no password. Saying so is the only right answer: counting it as a
    // failure would let a script lock the owner out of a wallet no password could ever open.
    if (isEnclaveFile(stored) || stored.header.kdf === undefined) return { ok: false, error: 'enclave_required' };

    const aad = aadFor(stored.header);
    const kek = await deriveKek(password, stored.header.kdf);
    /* READ AGAIN AFTER THE DERIVATION, and this is the whole of the concurrency fix on this
       side. The check at the top of this function runs before an await that takes half a second,
       so twenty callers arriving together all passed it before any of them had failed, and the
       backoff never engaged: sequential guessing walled at five while twenty concurrent guesses
       all came back "wrong password". The queue above serialises them; this line is what makes
       the wall hold even for a caller that somehow gets past it. */
    if (now() < backoffUntil) {
      wipe(kek);
      return { ok: false, error: 'locked_out', retryInSec: Math.ceil((backoffUntil - now()) / 1000) };
    }
    let unwrapped: Buffer | null = null;
    try {
      unwrapped = open(stored.wrap as Sealed, kek, aad);
    } catch {
      /* The wrap failed. That is either the password or an edited header, because the header is
         the AAD, and the two used to be reported as the same thing: "wrong password", which sends
         somebody whose receive address has just been swapped off to retype a password that was
         right. The proof tells them apart. It is the addresses sealed under this same key with an
         AAD that covers everything in the header EXCEPT the addresses, so it still opens on the
         one file where they were changed. It opening means the password is right.
         An attacker who edits the header can also delete this field, and then this is a wrong
         password again. What they cannot do is make an OPEN wallet serve their address, which is
         the loss this finding was about; this half is so the owner is told why. */
      if (stored.headerProof !== undefined) {
        try {
          const proof = open(stored.headerProof, kek, proofAad(stored.header));
          wipe(proof, kek);
          tampered = true;
          return {
            ok: false,
            error: 'tampered',
            detail:
              'the password is right and the wallet file has been edited: the addresses in its header are not the ones it was written with. No address is being shown until this is resolved. Restore the file from a backup, or move it aside and import your recovery phrase.',
          };
        } catch {
          // The proof did not open either, so the password really is wrong.
        }
      }
      failures += 1;
      if (failures >= MAX_FAILURES) {
        backoffUntil = now() + BACKOFF_MS;
        failures = 0;
      }
      return { ok: false, error: 'wrong_password' };
    } finally {
      wipe(kek);
    }

    let body: Buffer;
    try {
      body = open(stored.payload, unwrapped, aad);
      JSON.parse(body.toString('utf8'));
    } catch (err) {
      // The password was right and the file is not. Damage, not a typo, and it says so rather
      // than sending the owner to look for a password that would never have worked.
      return { ok: false, error: 'damaged', detail: err instanceof Error ? err.message : String(err) };
    } finally {
      wipe(unwrapped);
    }
    failures = 0;
    backoffUntil = 0;
    return { ok: true, body };
  }

  /* ONE PASSWORD CHECK AT A TIME, for every route that makes one.
     The failure counter and the backoff are the only thing between a weak password and a script
     that grinds it, and they were bypassable by asking twenty times at once: openOnce reads the
     backoff, then suspends for half a second inside the key derivation, so every concurrent
     caller passed the check before any of them had recorded a failure. /api/unlock had its own
     in-flight guard and was safe; /api/wallet/reveal and /api/wallet/export call unlock() and
     verify() directly and were not. Reproduced at twenty concurrent guesses: all twenty came
     back "wrong password" where five sequential ones already wall.
     The guard belongs here rather than in the routes because here is where the counter lives, so
     a route added later cannot forget it. Serialised rather than deduplicated: two different
     guesses are two attempts and both must be counted. */
  let queue: Promise<unknown> = Promise.resolve();
  function openWith(password: string): Promise<{ ok: true; body: Buffer } | Extract<UnlockResult, { ok: false }>> {
    const run = queue.then(
      () => openOnce(password),
      () => openOnce(password),
    );
    queue = run.catch(() => undefined);
    return run;
  }

  async function unlock(password: string): Promise<UnlockResult> {
    const opened = await openWith(password);
    if (!opened.ok) return opened;
    // Wiped, not dropped. Unlocking a wallet that was already open used to leave the previous
    // plaintext payload sitting in heap nothing would ever overwrite, which is the one thing
    // holding the payload as bytes rather than as an object exists to make possible. hold() does
    // the wiping, for the signing key beside it too.
    const payload = JSON.parse(opened.body.toString('utf8')) as KeysPayload;
    hold(opened.body, payload);
    /* The addresses this wallet actually holds, derived from the keys that just came out of the
       envelope. Everything that shows somebody an address reads these from here on, so an edited
       header cannot reach the Money-in screen of an open wallet. */
    openAddresses = addressesOf(payload);
    tampered = false;
    announce();
    return { ok: true };
  }

  // The same proof with none of the consequences: the payload is decrypted, checked and wiped,
  // and the lock state is exactly what it was.
  async function verify(password: string): Promise<UnlockResult> {
    const opened = await openWith(password);
    if (!opened.ok) return opened;
    wipe(opened.body);
    return { ok: true };
  }

  function lock(): boolean {
    stopClosing();
    if (plain === null) return false;
    wipe(plain, dataKey, evmKey, apiKey);
    plain = null;
    dataKey = null;
    evmKey = null;
    apiKey = null;
    apiAddress = null;
    announce();
    return true;
  }

  function stopClosing(): void {
    closers.clear();
    if (closeTimer !== null) clearInterval(closeTimer);
    closeTimer = null;
  }

  // A closer is finished when it says so or when its cap has passed; a `done` that throws cannot
  // hold the key either. The last one finished locks.
  function sweepClosers(): void {
    const at = now();
    for (const [key, closer] of closers) {
      let finished = at >= closer.until;
      if (!finished) {
        try {
          finished = closer.done();
        } catch {
          finished = true;
        }
      }
      if (finished) closers.delete(key);
    }
    if (closers.size === 0) lock();
  }

  /* Lock once `done` says the signatures it waits for are made, and no later than `capMs` from
     now. False when nothing is open to close. One closer per key, so a caller that asks again
     (the shell's screen-lock loop asks once a second) neither stacks closers nor moves the cap.
     The first closer is announced, because the state turns to locked there and the window has to
     draw it. Never decided on the spot: `done` is read on the next sweep, after whatever the
     caller is doing in this turn has written its rows. */
  function lockWhen(key: string, done: () => boolean, capMs: number): boolean {
    if (plain === null) return false;
    if (closers.has(key)) return true;
    const first = closers.size === 0;
    closers.set(key, { done, until: now() + capMs });
    if (closeTimer === null) {
      closeTimer = setInterval(sweepClosers, CLOSE_SWEEP_MS);
      closeTimer.unref?.();
    }
    if (first) announce();
    return true;
  }

  // ---------- version 2: the enclave ----------

  function storedFile(): KeystoreFile | null {
    try {
      return readKeystoreFile(file);
    } catch {
      return null;
    }
  }

  function custody(): Custody | null {
    const stored = storedFile();
    if (stored === null) return fs.existsSync(keysPath) ? 'software' : null;
    return isEnclaveFile(stored) ? 'secure-enclave' : 'software';
  }

  function enclave(): EnclaveRef | null {
    const stored = storedFile();
    return stored !== null && isEnclaveFile(stored) ? (stored.header.enclave ?? null) : null;
  }

  function enclaveRequest(): EnclaveUnwrapRequest | null {
    const stored = storedFile();
    if (stored === null || !isEnclaveFile(stored)) return null;
    const wrap = stored.wrap as SeWrapped;
    return {
      keyBlob: stored.header.enclave!.keyBlob,
      ephemeralPublicKey: wrap.ephemeralPublicKey,
      ciphertext: wrap.ciphertext,
      aad: proofAad(stored.header).toString('base64'),
    };
  }

  /* The version 2 write. One header, one data key, one wrap to the enclave, one payload under
     the data key, both envelopes under the header-minus-addresses AAD. The data key is handed
     back to the caller, which is about to hold the wallet open with it. */
  function writeEnclave(payload: KeysPayload, ref: EnclaveRef, dek: Buffer): KeystoreHeader {
    const header: KeystoreHeader = {
      version: 2,
      createdAt: new Date(now()).toISOString(),
      addresses: addressesOf(payload),
      hasMnemonic: typeof payload.mnemonic === 'string' && payload.mnemonic.length > 0,
      custody: 'secure-enclave',
      enclave: ref,
    };
    const aad = proofAad(header);
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    try {
      const out: KeystoreFile = {
        header,
        wrap: seWrap(dek, ref.publicKey, aad),
        payload: seal(body, dek, aad),
      };
      writeSecret(file, JSON.stringify(out, null, 2) + '\n');
    } finally {
      wipe(body);
    }
    return header;
  }

  function holdOpen(payload: KeysPayload, dek: Buffer, addrs: StoredAddresses): void {
    hold(Buffer.from(JSON.stringify(payload), 'utf8'), payload);
    if (dataKey !== null && dataKey !== dek) wipe(dataKey);
    dataKey = dek;
    openAddresses = addrs;
    announce();
  }

  /* The version 2 decrypt and NOTHING ELSE, the data-key twin of openOnce: whether the wallet
     ends up open is the caller's decision. The data key is wiped on every failure and handed back
     untouched on success. The addresses the header claims are compared against the ones the keys
     actually give: a header any process can edit is never believed over the payload only the
     enclave could open, so a mismatch is recorded, the derived addresses are served, and the
     window is told. */
  function openWithDataKey(dek: Buffer): { ok: true; body: Buffer; payload: KeysPayload } | Extract<UnlockResult, { ok: false }> {
    let stored: KeystoreFile | null;
    try {
      stored = readKeystoreFile(file);
    } catch (err) {
      wipe(dek);
      return { ok: false, error: 'damaged', detail: err instanceof Error ? err.message : String(err) };
    }
    if (stored === null) {
      wipe(dek);
      return { ok: false, error: 'no_wallet' };
    }
    if (!isEnclaveFile(stored)) {
      wipe(dek);
      return { ok: false, error: 'wrong_password', detail: 'this is a password wallet; the enclave cannot open it' };
    }
    let body: Buffer | null = null;
    let payload: KeysPayload;
    try {
      body = open(stored.payload, dek, proofAad(stored.header));
      payload = JSON.parse(body.toString('utf8')) as KeysPayload;
    } catch (err) {
      wipe(dek, body);
      return { ok: false, error: 'damaged', detail: err instanceof Error ? err.message : String(err) };
    }
    const derived = addressesOf(payload);
    tampered = !sameAddresses(derived, stored.header.addresses);
    openAddresses = derived;
    failures = 0;
    backoffUntil = 0;
    return { ok: true, body, payload };
  }

  function unlockWithDataKey(dek: Buffer): UnlockResult {
    const opened = openWithDataKey(dek);
    if (!opened.ok) return opened;
    hold(opened.body, opened.payload);
    if (dataKey !== null) wipe(dataKey);
    dataKey = dek;
    announce();
    return { ok: true };
  }

  /* A TOUCH OR A PASSWORD OPENS ONLY WHAT IT WAS ASKED FOR. The payload is opened for one read
     and wiped, and the lock state is exactly what it was: nothing is held, nothing is announced,
     so nothing queued is released and no plan re-arms. "Show your deposit address" verified the
     addresses through an unlock and locked again, but the unlock had already told every listener,
     and the runner re-armed a locked plan and took the trading key for a fresh session in that
     same tick; "Reveal your recovery phrase" left the whole wallet open for signing until the
     idle lock. Both read through here now. The addresses come out verified, as from any open. */
  function readWithDataKey<T>(dek: Buffer, read: (payload: KeysPayload) => T): { ok: true; value: T } | Extract<UnlockResult, { ok: false }> {
    const opened = openWithDataKey(dek);
    if (!opened.ok) return opened;
    try {
      return { ok: true, value: read(opened.payload) };
    } finally {
      wipe(opened.body, dek);
    }
  }

  // The same for a password wallet, through openWith, so every guess is counted.
  async function readWithPassword<T>(password: string, read: (payload: KeysPayload) => T): Promise<{ ok: true; value: T } | Extract<UnlockResult, { ok: false }>> {
    const opened = await openWith(password);
    if (!opened.ok) return opened;
    try {
      const payload = JSON.parse(opened.body.toString('utf8')) as KeysPayload;
      openAddresses = addressesOf(payload);
      tampered = false;
      return { ok: true, value: read(payload) };
    } finally {
      wipe(opened.body);
    }
  }

  /* An approval's Touch ID opens the wallet for that one move. On a wallet already open it only
     proves the touch opened this file, and changes nothing. On a shut one the payload is held
     the way a closing wallet holds it (lockWhen): state() says locked throughout, nothing is
     announced, so no plan re-arms, nothing queued is released and no other move can start, and
     the key goes as soon as `done` says this move has signed, or at the cap. It used to be a full
     unlock, and every move under the click threshold then ran with no click until the idle lock,
     on a touch whose dialog named one move. */
  function openFor(key: string, dek: Buffer, done: () => boolean, capMs: number): UnlockResult {
    if (plain !== null && closers.size === 0) {
      const proved = readWithDataKey(dek, () => true);
      return proved.ok ? { ok: true } : proved;
    }
    const opened = openWithDataKey(dek);
    if (!opened.ok) return opened;
    // The data key is not kept: nothing may rewrite the payload while the wallet is shut.
    if (plain === null) hold(opened.body, opened.payload);
    else wipe(opened.body);
    wipe(dek);
    lockWhen(key, done, capMs);
    return { ok: true };
  }

  function createWithEnclave(ref: EnclaveRef): { addresses: StoredAddresses } {
    if (hasKeystore()) throw new Error('this app already holds a wallet. Move keys.enc.json aside first, or import into a fresh data directory.');
    const made = newWallet();
    const payload = payloadFrom(made.mnemonic, made.wallet.keys, made.wallet.addresses);
    const dek = newDataKey();
    const header = writeEnclave(payload, ref, dek);
    tampered = false;
    holdOpen(payload, dek, header.addresses);
    return { addresses: header.addresses };
  }

  function importWithEnclave(ref: EnclaveRef, from: { mnemonic?: string; keys?: Partial<RailKeys> }): { addresses: StoredAddresses } {
    if (hasKeystore()) throw new Error('this app already holds a wallet. Move keys.enc.json aside first, or import into a fresh data directory.');
    const payload = payloadFromImport(from);
    const dek = newDataKey();
    const header = writeEnclave(payload, ref, dek);
    tampered = false;
    holdOpen(payload, dek, header.addresses);
    return { addresses: header.addresses };
  }

  async function rewrapToEnclave(password: string, ref: EnclaveRef): Promise<UnlockResult> {
    const opened = await openWith(password);
    if (!opened.ok) return opened;
    let payload: KeysPayload;
    try {
      payload = JSON.parse(opened.body.toString('utf8')) as KeysPayload;
    } finally {
      wipe(opened.body);
    }
    const dek = newDataKey();
    const header = writeEnclave(payload, ref, dek);
    tampered = false;
    holdOpen(payload, dek, header.addresses);
    return { ok: true };
  }

  function updatePayload(mutate: (payload: KeysPayload) => KeysPayload): StoredAddresses {
    if (plain === null || dataKey === null || closers.size > 0) throw new Error('the wallet is locked');
    const stored = readKeystoreFile(file);
    if (stored === null || !isEnclaveFile(stored)) throw new Error('only an enclave wallet can be rewritten in place');
    const next = mutate(keys());
    const aad = proofAad(stored.header);
    const body = Buffer.from(JSON.stringify(next), 'utf8');
    try {
      const out: KeystoreFile = { header: stored.header, wrap: stored.wrap, payload: seal(body, dataKey, aad) };
      writeSecret(file, JSON.stringify(out, null, 2) + '\n');
    } finally {
      wipe(body);
    }
    hold(Buffer.from(JSON.stringify(next), 'utf8'), next);
    openAddresses = addressesOf(next);
    announce();
    return openAddresses;
  }

  /* Overwritten before it is unlinked, so the bytes are gone from the block as well as from the
     directory. APFS may still hold a snapshot; that is the disk's promise to keep, not this
     function's, and the enclave wrap is what makes a lingering copy worthless anyway. */
  function forget(): { destroyed: string } {
    if (demo) throw new Error(DEMO_REFUSAL);
    lock();
    if (fs.existsSync(file)) {
      const size = fs.statSync(file).size;
      fs.writeFileSync(file, crypto.randomBytes(Math.max(size, 4096)));
      fs.unlinkSync(file);
    }
    openAddresses = null;
    tampered = false;
    announce();
    return { destroyed: file };
  }

  async function create(password: string): Promise<{ mnemonic: string; addresses: StoredAddresses }> {
    if (hasKeystore()) throw new Error('this app already holds a wallet. Move keys.enc.json aside first, or import into a fresh data directory.');
    const made = newWallet();
    const payload = payloadFrom(made.mnemonic, made.wallet.keys, made.wallet.addresses);
    const addrs = await write(password, payload, params());
    // Unlocked immediately: the person is standing there having just typed the password, and
    // making them type it twice teaches nothing.
    hold(Buffer.from(JSON.stringify(payload), 'utf8'), payload);
    openAddresses = addrs;
    announce();
    return { mnemonic: made.mnemonic, addresses: addrs };
  }

  function payloadFromImport(from: { mnemonic?: string; keys?: Partial<RailKeys> }): KeysPayload {
    if (typeof from.mnemonic === 'string' && from.mnemonic.trim() !== '') {
      const wallet = walletFromMnemonic(from.mnemonic);
      return payloadFrom(normaliseMnemonic(from.mnemonic), wallet.keys, wallet.addresses);
    }
    const raw = from.keys ?? {};
    // A Solana or NEAR key is refused, not dropped: dropping it would tell the person their
    // key was taken when the wallet will never read it.
    if (raw.solana !== undefined || raw.nearSecret !== undefined) {
      throw new Error('Phosphor holds one EVM key; a Solana or NEAR key cannot be imported');
    }
    if (raw.evm === undefined || (raw.evm as string) === '') throw new Error('bring twelve words or an EVM private key');
    const derived = addressesFromKeys({ evm: raw.evm });
    return { evm: { address: derived.evm, privateKey: raw.evm } };
  }

  async function importWallet(password: string, from: { mnemonic?: string; keys?: Partial<RailKeys> }): Promise<{ addresses: StoredAddresses }> {
    if (hasKeystore()) throw new Error('this app already holds a wallet. Move keys.enc.json aside first, or import into a fresh data directory.');
    const payload = payloadFromImport(from);
    const addrs = await write(password, payload, params());
    hold(Buffer.from(JSON.stringify(payload), 'utf8'), payload);
    openAddresses = addrs;
    announce();
    return { addresses: addrs };
  }

  /* A FRESH salt, so the backup and the live file do not share a derived key: two files under
     one salt means one cracked password opens both, and a backup is the copy that ends up
     somewhere less careful than this directory. */
  async function exportTo(target: string, password: string): Promise<void> {
    /* The payload is read UNDER THE PASSWORD GIVEN when the wallet is shut, rather than off an
       open one, so writing a backup from behind the lock leaves the lock exactly where it was.
       An already open wallet is read straight out of memory, which is the same bytes. */
    let payload: KeysPayload;
    if (plain !== null) {
      payload = keys();
    } else {
      const opened = await openWith(password);
      if (!opened.ok) throw new Error(`that password does not open this wallet (${opened.error})`);
      payload = JSON.parse(opened.body.toString('utf8')) as KeysPayload;
      wipe(opened.body);
    }
    const kdf = params();
    const header: KeystoreHeader = {
      version: 1,
      createdAt: new Date(now()).toISOString(),
      kdf,
      addresses: addressesOf(payload),
      hasMnemonic: typeof payload.mnemonic === 'string' && payload.mnemonic.length > 0,
    };
    const aad = aadFor(header);
    const dataKey = newDataKey();
    const kek = await deriveKek(password, kdf);
    try {
      const body = Buffer.from(JSON.stringify(payload), 'utf8');
      const out = {
        header,
        wrap: seal(dataKey, kek, aad),
        payload: seal(body, dataKey, aad),
        headerProof: seal(Buffer.from(canonical(header.addresses), 'utf8'), kek, proofAad(header)),
      };
      writeSecret(target, JSON.stringify(out, null, 2) + '\n', false);
      wipe(body);
    } finally {
      wipe(dataKey, kek);
    }
  }

  function reveal(): { mnemonic: string | null; keys: KeysPayload } {
    if (plain === null || closers.size > 0) throw new Error('the wallet is locked');
    const payload = keys();
    return { mnemonic: typeof payload.mnemonic === 'string' ? payload.mnemonic : null, keys: payload };
  }

  return {
    state,
    isUnlocked: () => plain !== null && closers.size === 0,
    keyHeld: () => plain !== null,
    lockWhen,
    addresses,
    addressReport,
    header: () => readHeader(keysPath),
    unlock,
    verify,
    lock,
    create,
    importWallet,
    migrate: async (password) => {
      if (demo) throw new Error(DEMO_REFUSAL);
      const setPlain = (b: Buffer): void => {
        const payload = JSON.parse(b.toString('utf8')) as KeysPayload;
        hold(b, payload);
        openAddresses = addressesOf(payload);
        announce();
      };
      return migrateInto({ keysPath, file, write, kdf: params, setPlain, open: openWith }, password);
    },
    exportTo,
    reveal,
    keys,
    evmPrivateKey,
    apiWallet,
    path: () => file,
    custody,
    enclave,
    enclaveRequest,
    unlockWithDataKey,
    readWithDataKey,
    readWithPassword,
    openFor,
    createWithEnclave,
    importWithEnclave,
    rewrapToEnclave,
    updatePayload,
    forget,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// ---------- migration ----------

type MigrateDeps = {
  keysPath: string;
  file: string;
  write: (password: string, payload: KeysPayload, kdf: KdfParams) => Promise<StoredAddresses>;
  kdf: () => KdfParams;
  setPlain: (body: Buffer) => void;
  // The keystore's own openWith: the failure counter and the backoff every password check takes.
  open: (password: string) => Promise<{ ok: true; body: Buffer } | Extract<UnlockResult, { ok: false }>>;
};

// Every file beside keys.json that is a copy of it. The three the audit found by name
// (keys.json.bak-2026-08-20, keys.json.bak-before-near, keys.json.generated.bak) plus anything
// else matching, because the next stale copy will have the next ad hoc suffix.
export function backupCopies(keysPath: string): string[] {
  const dir = path.dirname(keysPath);
  const base = path.basename(keysPath);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name !== base && name.startsWith(base) && /\.(bak|backup|old|generated)/i.test(name.slice(base.length)))
    .map((name) => path.join(dir, name))
    // statSync rather than lstatSync, and wrapped: a dangling symlink beside the key file
    // would otherwise throw here and take the whole migration with it.
    .filter((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
}

/* Overwrite, force to disk, truncate, unlink. In that order and with the fsync in the middle,
   because a rename or an unlink alone leaves the bytes on the device for anything reading the
   raw file system.
   Honest limit, and the window says it too: on APFS with snapshots or Time Machine local
   snapshots this does not guarantee erasure. The only complete answer is rotating to a fresh
   wallet after migrating, which is why the screen offers it. */
export function destroyPlaintext(target: string, demo: boolean = envIsDemo()): void {
  if (demo) {
    throw new Error(
      `demo mode never destroys a plaintext key file (refused to shred ${path.basename(target)}). ${DEMO_REFUSAL}`,
    );
  }
  const size = fs.statSync(target).size;
  const fd = fs.openSync(target, 'r+');
  try {
    if (size > 0) {
      fs.writeSync(fd, crypto.randomBytes(size), 0, size, 0);
      fs.fsyncSync(fd);
    }
    fs.ftruncateSync(fd, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.unlinkSync(target);
}

// VERIFY BEFORE DESTROYING. A half-migration that has already deleted the plaintext is fund
// loss, so the round trip is decrypted back and the derived EVM address compared against the
// one the plaintext file held, and only then is anything overwritten.
/* Every plaintext copy of the key still on disk: the file itself and every backup beside it.
   The list the destroy loop walks, and the list a resumed migration walks again. */
function plaintextResidue(keysPath: string): string[] {
  // BACKUPS FIRST. The loop is not atomic, and a process that died inside it used to have
  // destroyed the primary and left a backup: state() then read `locked` because the envelope
  // verifies, the migration screen never appeared again, migrate() refused because the envelope
  // exists, and the master key sat on disk in the clear with nothing in the app able to reach
  // it. Shredding the copies before the original inverts that: a death inside the loop leaves
  // the primary, so the app still reports a plaintext key file and can be asked to finish.
  return [...backupCopies(keysPath), ...(fs.existsSync(keysPath) ? [keysPath] : [])];
}

/* THE SECOND HALF OF THE SAME PROBLEM: finishing a migration that was interrupted.
   Reached only when the envelope already exists AND plaintext is still beside it, which is
   exactly the state a kill inside the destroy loop leaves. The house rule still holds and is why
   this is not simply a delete: the envelope is opened with the password given and the addresses
   it derives are compared against the ones the surviving plaintext derives, so nothing is
   shredded until the encrypted wallet is proved to hold the same keys.
   The password goes through the keystore's openWith, like every other check of it. This used to
   derive and open on its own, which made it the one door with no failure count: a window-token
   holder could grind guesses at full speed and never meet the backoff the unlock walls at. */
async function resumeDestroy(deps: MigrateDeps, password: string, residue: string[]): Promise<{ destroyed: string[]; addresses: StoredAddresses }> {
  const opened = await deps.open(password);
  if (!opened.ok) {
    const left = 'so the plaintext key file was left alone';
    if (opened.error === 'locked_out') throw new Error(`Too many tries. Wait ${opened.retryInSec ?? 30} seconds and try again; the plaintext key file was left alone.`);
    if (opened.error === 'enclave_required') throw new Error('the encrypted wallet is an enclave file, which this migration does not open');
    if (opened.error === 'no_wallet' || opened.error === 'damaged') throw new Error('the encrypted wallet could not be read, so nothing was destroyed');
    if (opened.error === 'tampered') throw new Error(`${opened.detail ?? 'the wallet file has been edited'} (${left})`);
    throw new Error(`that password does not open the encrypted wallet, ${left}`);
  }
  const body = opened.body;
  const destroyed: string[] = [];
  let encrypted: StoredAddresses;
  try {
    encrypted = addressesOf(JSON.parse(body.toString('utf8')) as KeysPayload);
    for (const target of residue) {
      let onDisk: StoredAddresses;
      try {
        onDisk = addressesOf(JSON.parse(fs.readFileSync(target, 'utf8')) as KeysPayload);
      } catch {
        throw new Error(`${target} is not a key file this app can read, so it was left alone`);
      }
      if (onDisk.evm !== encrypted.evm || onDisk.solana !== encrypted.solana || onDisk.near !== encrypted.near) {
        throw new Error(`${target} holds a different wallet from the encrypted one, so it was left alone. Move it aside by hand.`);
      }
    }
    for (const target of residue) {
      destroyPlaintext(target);
      destroyed.push(target);
    }
  } catch (err) {
    wipe(body);
    throw err;
  }
  deps.setPlain(body);
  return { destroyed, addresses: encrypted };
}

async function migrateInto(deps: MigrateDeps, password: string): Promise<{ destroyed: string[]; addresses: StoredAddresses }> {
  if (fs.existsSync(deps.file)) {
    const residue = plaintextResidue(deps.keysPath);
    if (residue.length === 0) throw new Error('this app already holds an encrypted wallet, so there is nothing to migrate');
    return resumeDestroy(deps, password, residue);
  }
  if (!fs.existsSync(deps.keysPath)) throw new Error(`no plaintext key file at ${deps.keysPath}`);

  const raw = fs.readFileSync(deps.keysPath, 'utf8');
  const payload = JSON.parse(raw) as KeysPayload;
  const before = addressesOf(payload);
  if (before.evm === null && before.solana === null && before.near === null) {
    throw new Error(`${deps.keysPath} holds no key this app recognises, so there is nothing to migrate`);
  }

  const addresses = await deps.write(password, payload, deps.kdf());

  // Read the file back from disk with the password just given, exactly as a later boot will.
  const stored = readKeystoreFile(deps.file);
  if (stored === null) throw new Error('the encrypted wallet was not written');
  if (stored.header.kdf === undefined) throw new Error('the encrypted wallet was written without a KDF, which a password file never is');
  const aad = aadFor(stored.header);
  const kek = await deriveKek(password, stored.header.kdf);
  let body: Buffer;
  try {
    const dataKey = open(stored.wrap as Sealed, kek, aad);
    body = open(stored.payload, dataKey, aad);
    wipe(dataKey);
  } finally {
    wipe(kek);
  }

  const roundTripped = body.toString('utf8');
  if (roundTripped !== JSON.stringify(payload)) {
    fs.unlinkSync(deps.file);
    throw new Error('the encrypted wallet did not decrypt to what went in, so the plaintext file was left alone');
  }
  const after = addressesOf(JSON.parse(roundTripped) as KeysPayload);
  if (after.evm !== before.evm || after.solana !== before.solana || after.near !== before.near) {
    fs.unlinkSync(deps.file);
    throw new Error('the encrypted wallet derives a different address, so the plaintext file was left alone');
  }

  const destroyed: string[] = [];
  for (const target of plaintextResidue(deps.keysPath)) {
    destroyPlaintext(target);
    destroyed.push(target);
  }
  deps.setPlain(body);
  return { destroyed, addresses };
}
