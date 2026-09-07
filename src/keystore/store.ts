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
import type { Addresses, RailKeys } from './derive.ts';
import { atomicWrite } from '../fsatomic.ts';

export const KEYSTORE_FILENAME = 'keys.enc.json';

// Five failures, then thirty seconds. Not a lockout an attacker can trigger against the owner
// (it is a local file behind a window token) and not a defence against an offline attack
// either, which the KDF answers. It is what stops a script from grinding a weak password
// through the HTTP route at the speed of the event loop.
const MAX_FAILURES = 5;
const BACKOFF_MS = 30_000;

/* DEMO MODE NEVER DESTROYS A KEY FILE, and this is the second lock on a door the config file
   already shut. The first lock is that keysPath now comes from the data directory, so a demo
   backend on a throwaway data dir has its own empty wallet and cannot see the real one. This
   one holds even when a demo process is pointed at a real key file by hand: migration shreds
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

export type KeystoreHeader = {
  version: 1;
  createdAt: string;
  kdf: KdfParams;
  addresses: StoredAddresses;
  // Whether the payload carries twelve words. A wallet imported from three raw keys has none,
  // and the window must not offer to show a phrase that does not exist.
  hasMnemonic: boolean;
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
type KeystoreFile = { header: KeystoreHeader; wrap: Sealed; payload: Sealed; headerProof?: Sealed };

export type UnlockResult =
  | { ok: true }
  | { ok: false; error: 'wrong_password' | 'no_wallet' | 'damaged' | 'locked_out' | 'tampered'; retryInSec?: number; detail?: string };

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
  isUnlocked(): boolean;
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
  path(): string;
  onChange(fn: (state: LockState) => void): () => void;
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
  if (parsed.header?.version !== 1) throw new Error(`${file} is not a keystore this app knows how to open`);
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

function payloadFrom(mnemonic: string | null, keys: RailKeys, addresses: Addresses): KeysPayload {
  return {
    ...(mnemonic !== null ? { mnemonic } : {}),
    evm: { address: addresses.evm, privateKey: keys.evm },
    solana: { address: addresses.solana, secretKey: keys.solana },
    near: { accountId: addresses.near, publicKey: addresses.nearPublicKey, secretKey: keys.nearSecret },
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

  function announce(): void {
    const s = state();
    for (const fn of listeners) fn(s);
  }

  function hasKeystore(): boolean {
    return fs.existsSync(file);
  }

  function state(): LockState {
    if (plain !== null) return 'unlocked';
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
    if (tampered) return { addresses: NO_ADDRESSES, verified: false, tampered: true };
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
    let dataKey: Buffer | null = null;
    try {
      dataKey = open(stored.wrap, kek, aad);
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
      body = open(stored.payload, dataKey, aad);
      JSON.parse(body.toString('utf8'));
    } catch (err) {
      // The password was right and the file is not. Damage, not a typo, and it says so rather
      // than sending the owner to look for a password that would never have worked.
      return { ok: false, error: 'damaged', detail: err instanceof Error ? err.message : String(err) };
    } finally {
      wipe(dataKey);
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
    // holding the payload as bytes rather than as an object exists to make possible.
    if (plain !== null) wipe(plain);
    plain = opened.body;
    /* The addresses this wallet actually holds, derived from the keys that just came out of the
       envelope. Everything that shows somebody an address reads these from here on, so an edited
       header cannot reach the Money-in screen of an open wallet. */
    openAddresses = addressesOf(JSON.parse(plain.toString('utf8')) as KeysPayload);
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
    if (plain === null) return false;
    wipe(plain);
    plain = null;
    announce();
    return true;
  }

  async function create(password: string): Promise<{ mnemonic: string; addresses: StoredAddresses }> {
    if (hasKeystore()) throw new Error('this app already holds a wallet. Move keys.enc.json aside first, or import into a fresh data directory.');
    const made = newWallet();
    const payload = payloadFrom(made.mnemonic, made.wallet.keys, made.wallet.addresses);
    const addrs = await write(password, payload, params());
    // Unlocked immediately: the person is standing there having just typed the password, and
    // making them type it twice teaches nothing.
    plain = Buffer.from(JSON.stringify(payload), 'utf8');
    openAddresses = addrs;
    announce();
    return { mnemonic: made.mnemonic, addresses: addrs };
  }

  async function importWallet(password: string, from: { mnemonic?: string; keys?: Partial<RailKeys> }): Promise<{ addresses: StoredAddresses }> {
    if (hasKeystore()) throw new Error('this app already holds a wallet. Move keys.enc.json aside first, or import into a fresh data directory.');
    let payload: KeysPayload;
    if (typeof from.mnemonic === 'string' && from.mnemonic.trim() !== '') {
      const wallet = walletFromMnemonic(from.mnemonic);
      payload = payloadFrom(normaliseMnemonic(from.mnemonic), wallet.keys, wallet.addresses);
    } else {
      const raw = from.keys ?? {};
      if (raw.evm === undefined && raw.solana === undefined && raw.nearSecret === undefined) {
        throw new Error('bring twelve words or at least one private key');
      }
      const derived = addressesFromKeys(raw);
      payload = {
        ...(raw.evm !== undefined ? { evm: { address: derived.evm, privateKey: raw.evm } } : {}),
        ...(raw.solana !== undefined ? { solana: { address: derived.solana, secretKey: raw.solana } } : {}),
        ...(raw.nearSecret !== undefined
          ? { near: { accountId: derived.near, publicKey: derived.nearPublicKey, secretKey: raw.nearSecret } }
          : {}),
      };
    }
    const addrs = await write(password, payload, params());
    plain = Buffer.from(JSON.stringify(payload), 'utf8');
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
    const payload = keys();
    if (plain === null) throw new Error('the wallet is locked');
    return { mnemonic: typeof payload.mnemonic === 'string' ? payload.mnemonic : null, keys: payload };
  }

  return {
    state,
    isUnlocked: () => plain !== null,
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
      return migrateInto({ keysPath, file, write, kdf: params, setPlain: (b) => { plain = b; openAddresses = addressesOf(JSON.parse(b.toString('utf8')) as KeysPayload); announce(); } }, password);
    },
    exportTo,
    reveal,
    keys,
    path: () => file,
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
async function migrateInto(deps: MigrateDeps, password: string): Promise<{ destroyed: string[]; addresses: StoredAddresses }> {
  if (fs.existsSync(deps.file)) throw new Error('this app already holds an encrypted wallet, so there is nothing to migrate');
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
  const aad = aadFor(stored.header);
  const kek = await deriveKek(password, stored.header.kdf);
  let body: Buffer;
  try {
    const dataKey = open(stored.wrap, kek, aad);
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
  for (const target of [deps.keysPath, ...backupCopies(deps.keysPath)]) {
    destroyPlaintext(target);
    destroyed.push(target);
  }
  deps.setPlain(body);
  return { destroyed, addresses };
}
