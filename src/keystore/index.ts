// The door every signer and every reader in the app comes through.
//
// One keystore per process, installed by src/main.ts at boot. The signers reach it through
// this module rather than taking a handle as a parameter, and that is a deliberate trade:
// threading one through the ten rail modules would touch every file the other tracks are
// editing, and the property that matters is not the shape of the call. It is that a locked
// wallet cannot produce a key, and that is held by the throw inside Keystore.keys().
//
// The rule these helpers enforce, and the audit's task 6 in one line: a SIGNER takes key
// material and therefore fails while locked; a READER takes an address and therefore does not.
// Anything in src/ that opens a key file itself is a bug, and the grep that finds it is
// `readFileSync` beside `keys`.

import fs from 'node:fs';

import type { Keystore, KeysPayload, StoredAddresses } from './store.ts';

export { createKeystore, keystorePathFor, readHeader, backupCopies, KEYSTORE_FILENAME } from './store.ts';
export type { Keystore, KeysPayload, KeystoreHeader, LockState, StoredAddresses, UnlockResult } from './store.ts';

let active: Keystore | null = null;

export function useKeystore(store: Keystore | null): void {
  active = store;
}

/* The plaintext fallback lives here and nowhere else. An install that has a keys.json and has
   not migrated yet keeps signing; once it has migrated the file is gone and this branch is
   unreachable. Every other module asks this one. */
export function keyMaterial(keysPath: string): KeysPayload {
  if (active !== null) return active.keys();
  if (!fs.existsSync(keysPath)) {
    throw new Error(`no wallet at ${keysPath}. Create one in the app window.`);
  }
  return JSON.parse(fs.readFileSync(keysPath, 'utf8')) as KeysPayload;
}

// Addresses, which work while locked because they come from the plaintext header. A reader
// that called keyMaterial() for an address would turn every balance read into a signing
// operation, which is exactly the mistake this pair of functions exists to prevent.
export function walletAddresses(): StoredAddresses {
  if (active !== null) return active.addresses();
  return { evm: null, solana: null, near: null, nearPublicKey: null };
}

export function evmPrivateKey(keysPath: string): `0x${string}` {
  const key = keyMaterial(keysPath).evm?.privateKey;
  if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('this wallet has no valid EVM private key');
  }
  return key as `0x${string}`;
}

export function isLocked(): boolean {
  return active !== null && active.state() === 'locked';
}
