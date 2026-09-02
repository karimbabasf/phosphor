// The keystore: one encrypted file, one unlocked handle, and the four things that produce it
// (create, import, migrate, unlock).
//
// THE FILE. `keys.enc.json` sits beside where `keys.json` lived, at 0600, and holds three
// parts: a plaintext header, the data key wrapped under the password, and the payload
// encrypted under the data key. The header is the additional authenticated data for both, so
// it cannot be edited: the addresses in it are what every read path uses while the wallet is
// locked, and an attacker who could swap the EVM address there would own the receive screen.
//
// WHAT LOCKED MEANS. Locked is not "the app stops". Every read works, because addresses come
// from the header. Every write proposal is still authored and policy-checked and queued; see
// pending_unlock in src/proposals/lifecycle.ts. What locked removes is the ability to SIGN.
//
// THE PLAINTEXT FALLBACK, and it is deliberate. An install that has a `keys.json` and has not
// migrated yet keeps working: state() reports `needs_migration` and the readers below fall
// back to that file. Refusing instead would mean the upgrade that adds custody is the upgrade
// that breaks the wallet, and the migration would be forced rather than verified. It is one
// function, named, and it is the only place in the app that opens a plaintext key file.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { aadFor, newDataKey, open, seal, wipe } from './envelope.ts';
import type { Sealed } from './envelope.ts';
import { defaultParams, deriveKek } from './kdf.ts';
import type { KdfParams } from './kdf.ts';
import { addressesFromKeys, newWallet, normaliseMnemonic, walletFromMnemonic } from './derive.ts';
import type { Addresses, RailKeys } from './derive.ts';

export const KEYSTORE_FILENAME = 'keys.enc.json';

// Five failures, then thirty seconds. Not a lockout an attacker can trigger against the owner
// (it is a local file behind a window token) and not a defence against an offline attack
// either, which the KDF answers. It is what stops a script from grinding a weak password
// through the HTTP route at the speed of the event loop.
export const MAX_FAILURES = 5;
export const BACKOFF_MS = 30_000;

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

type KeystoreFile = { header: KeystoreHeader; wrap: Sealed; payload: Sealed };

export type UnlockResult =
  | { ok: true }
  | { ok: false; error: 'wrong_password' | 'no_wallet' | 'damaged' | 'locked_out'; retryInSec?: number; detail?: string };

export type Keystore = {
  state(): LockState;
  isUnlocked(): boolean;
  addresses(): StoredAddresses;
  header(): KeystoreHeader | null;
  unlock(password: string): Promise<UnlockResult>;
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
   the old file or the new one and never half of one. Track B is adding src/fsatomic.ts with
   the same shape for the app's other seven writers; this stays here because a key file must
   not wait on another track to be written safely.
   `ownDir` is false for an export, which lands wherever the person chose. Tightening the mode
   of the app's own key directory is right; tightening the mode of somebody's Documents folder
   is not ours to do, and on a shared temp directory it is not even permitted. */
function writeSecret(target: string, body: string, ownDir = true): void {
  if (ownDir) {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(target), 0o700);
  }
  const tmp = `${target}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
}

export function readKeystoreFile(file: string): KeystoreFile | null {
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as KeystoreFile;
  if (parsed.header?.version !== 1) throw new Error(`${file} is not a keystore this app knows how to open`);
  return parsed;
}

// The header alone, with no password. This is what makes a locked app useful: the addresses
// every balance read needs are here, in the clear, authenticated by the tag on the payload.
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

function payloadFrom(mnemonic: string | null, keys: RailKeys, addresses: Addresses): KeysPayload {
  return {
    ...(mnemonic !== null ? { mnemonic } : {}),
    evm: { address: addresses.evm, privateKey: keys.evm },
    solana: { address: addresses.solana, secretKey: keys.solana },
    near: { accountId: addresses.near, publicKey: addresses.nearPublicKey, secretKey: keys.nearSecret },
  };
}

// ---------- the store ----------

export function createKeystore(opts: { keysPath: string; now?: () => number; kdf?: () => KdfParams }): Keystore {
  const keysPath = opts.keysPath;
  const file = keystorePathFor(keysPath);
  const now = opts.now ?? Date.now;
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

  function addresses(): StoredAddresses {
    const head = readHeader(keysPath);
    if (head !== null) return head.addresses;
    // Before migration the addresses come from the plaintext file, which is the only place
    // they exist yet. Same answer, worse storage, and the migration screen says so.
    if (plain === null && fs.existsSync(keysPath)) {
      try {
        return addressesOf(JSON.parse(fs.readFileSync(keysPath, 'utf8')) as KeysPayload);
      } catch {
        return { evm: null, solana: null, near: null, nearPublicKey: null };
      }
    }
    return { evm: null, solana: null, near: null, nearPublicKey: null };
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
      writeSecret(file, JSON.stringify({ header, wrap, payload: sealedPayload }, null, 2) + '\n');
      wipe(body);
      return header.addresses;
    } finally {
      wipe(dataKey, kek);
    }
  }

  async function unlock(password: string): Promise<UnlockResult> {
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
    let dataKey: Buffer | null = null;
    try {
      dataKey = open(stored.wrap, kek, aad);
    } catch {
      /* The wrap failed, which is the password. A tampered header fails here too, because the
         header is the AAD, and calling that a wrong password would send the owner off typing
         it again; the payload check below is what tells the two apart when the wrap opens. */
      failures += 1;
      if (failures >= MAX_FAILURES) {
        backoffUntil = now() + BACKOFF_MS;
        failures = 0;
      }
      return { ok: false, error: 'wrong_password' };
    } finally {
      wipe(kek);
    }

    try {
      const body = open(stored.payload, dataKey, aad);
      JSON.parse(body.toString('utf8'));
      plain = body;
    } catch (err) {
      // The password was right and the file is not. Damage, not a typo, and it says so rather
      // than sending the owner to look for a password that would never have worked.
      return { ok: false, error: 'damaged', detail: err instanceof Error ? err.message : String(err) };
    } finally {
      wipe(dataKey);
    }
    failures = 0;
    backoffUntil = 0;
    announce();
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
    announce();
    return { addresses: addrs };
  }

  /* A FRESH salt, so the backup and the live file do not share a derived key: two files under
     one salt means one cracked password opens both, and a backup is the copy that ends up
     somewhere less careful than this directory. */
  async function exportTo(target: string, password: string): Promise<void> {
    const payload = keys();
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
      const out = { header, wrap: seal(dataKey, kek, aad), payload: seal(body, dataKey, aad) };
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
    header: () => readHeader(keysPath),
    unlock,
    lock,
    create,
    importWallet,
    migrate: (password) => migrateInto({ keysPath, file, write, kdf: params, setPlain: (b) => { plain = b; announce(); } }, password),
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
    .filter((p) => fs.statSync(p).isFile());
}

/* Overwrite, force to disk, truncate, unlink. In that order and with the fsync in the middle,
   because a rename or an unlink alone leaves the bytes on the device for anything reading the
   raw file system.
   Honest limit, and the window says it too: on APFS with snapshots or Time Machine local
   snapshots this does not guarantee erasure. The only complete answer is rotating to a fresh
   wallet after migrating, which is why the screen offers it. */
export function destroyPlaintext(target: string): void {
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
export async function migrateInto(deps: MigrateDeps, password: string): Promise<{ destroyed: string[]; addresses: StoredAddresses }> {
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
