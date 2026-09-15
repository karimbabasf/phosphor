// What the vault remembers about itself that is not a key.
//
// Two facts, in state/vault.json rather than in the key file: whether the recovery phrase has
// been PROVEN backed up (three words typed back, not merely shown), and how long the window may
// sit idle before the wallet locks. They are outside the key file on purpose. The key file's
// header is the AAD of both envelopes, so a flag that flips there would break the tag, and a
// wallet that will not open because somebody backed it up is not a wallet.
//
// Nothing here is a control. A process that edits this file can clear the backed-up flag (and
// get nagged) or set it (and lose the nag); it cannot reach a key by doing either.

import fs from 'node:fs';
import path from 'node:path';

import { atomicWrite } from '../fsatomic.ts';

export const IDLE_MINUTES_CHOICES = [5, 15, 60] as const;
export type IdleMinutes = (typeof IDLE_MINUTES_CHOICES)[number];

export type VaultPrefsData = {
  backedUp: boolean;
  backedUpAt: string | null;
  idleMinutes: IdleMinutes;
};

export type VaultPrefs = {
  get(): VaultPrefsData;
  markBackedUp(now?: () => number): VaultPrefsData;
  clearBackedUp(): VaultPrefsData;
  setIdleMinutes(minutes: number): VaultPrefsData;
};

const DEFAULTS: VaultPrefsData = { backedUp: false, backedUpAt: null, idleMinutes: 15 };

export function createVaultPrefs(dataDir: string): VaultPrefs {
  const file = path.join(dataDir, 'vault.json');

  function read(): VaultPrefsData {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<VaultPrefsData>;
      const idle = IDLE_MINUTES_CHOICES.find((m) => m === raw.idleMinutes) ?? DEFAULTS.idleMinutes;
      return {
        backedUp: raw.backedUp === true,
        backedUpAt: typeof raw.backedUpAt === 'string' ? raw.backedUpAt : null,
        idleMinutes: idle,
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function write(next: VaultPrefsData): VaultPrefsData {
    atomicWrite(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    return next;
  }

  return {
    get: read,
    markBackedUp: (now = Date.now) => write({ ...read(), backedUp: true, backedUpAt: new Date(now()).toISOString() }),
    clearBackedUp: () => write({ ...read(), backedUp: false, backedUpAt: null }),
    setIdleMinutes(minutes) {
      const idle = IDLE_MINUTES_CHOICES.find((m) => m === minutes);
      if (idle === undefined) throw new Error(`idle minutes must be one of ${IDLE_MINUTES_CHOICES.join(', ')}`);
      return write({ ...read(), idleMinutes: idle });
    },
  };
}
