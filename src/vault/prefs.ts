// What the vault remembers about itself that is not a key.
//
// Two facts, in state/vault.json rather than in the key file: whether the wallet's backup has
// been PROVEN (three words of its recovery phrase typed back, or its whole private key when it
// has no phrase, not merely shown), and how long the window may sit idle before the
// wallet locks. They are outside the key file on purpose. The key file's header is the AAD of both
// envelopes, so a flag that flips there would break the tag, and a wallet that will not open
// because somebody backed it up is not a wallet.
//
// Nothing here is a control. A process that edits this file can clear the backed-up flag (and
// get nagged) or set it (and lose the nag); it cannot reach a key by doing either. The proof names
// the wallet it was made for, so a key file swapped in from outside the app does not inherit
// another wallet's (src/http/vault.ts, backupProven).
//
// THE IDLE TIME IS STORED ONLY ONCE SOMEBODY PICKS ONE, so the default can change under the
// wallets that never did. Until 0.10.13 every write here also saved the default beside the flag
// it was writing, so a file that says 15 with no `idleChosen` beside it is that old default and
// reads as no choice at all. A 15 picked on purpose under those versions cannot be told from it
// and gets the new default too, which errs toward the shorter lock; 5 and 60 were always picks.

import fs from 'node:fs';
import path from 'node:path';

import { atomicWrite } from '../fsatomic.ts';

export const IDLE_MINUTES_CHOICES = [5, 15, 60] as const;
export type IdleMinutes = (typeof IDLE_MINUTES_CHOICES)[number];

// The window sits idle this long before the wallet locks, unless the person picked otherwise.
export const DEFAULT_IDLE_MINUTES: IdleMinutes = 5;
// What 0.10.12 and earlier wrote into the file when nobody had picked.
const OLD_DEFAULT_IDLE_MINUTES = 15;

export type VaultPrefsData = {
  backedUp: boolean;
  backedUpAt: string | null;
  // The wallet the proof was made for, its EVM address in lower case. Null when the proof was
  // written before proofs named their wallet, and such a proof stands as it always did.
  backedUpFor?: string | null;
  idleMinutes: IdleMinutes;
};

export type VaultPrefs = {
  get(): VaultPrefsData;
  markBackedUp(now?: () => number, wallet?: string | null): VaultPrefsData;
  clearBackedUp(): VaultPrefsData;
  setIdleMinutes(minutes: number): VaultPrefsData;
};

// What the file holds: the idle time only when it was picked.
type Stored = { backedUp: boolean; backedUpAt: string | null; backedUpFor: string | null; chosen: IdleMinutes | null };

export function createVaultPrefs(dataDir: string): VaultPrefs {
  const file = path.join(dataDir, 'vault.json');

  function stored(): Stored {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<VaultPrefsData> & { idleChosen?: unknown };
      const idle = IDLE_MINUTES_CHOICES.find((m) => m === raw.idleMinutes) ?? null;
      const picked = raw.idleChosen === true || idle !== OLD_DEFAULT_IDLE_MINUTES;
      return {
        backedUp: raw.backedUp === true,
        backedUpAt: typeof raw.backedUpAt === 'string' ? raw.backedUpAt : null,
        backedUpFor: typeof raw.backedUpFor === 'string' ? raw.backedUpFor.toLowerCase() : null,
        chosen: picked ? idle : null,
      };
    } catch {
      return { backedUp: false, backedUpAt: null, backedUpFor: null, chosen: null };
    }
  }

  function view(s: Stored): VaultPrefsData {
    return { backedUp: s.backedUp, backedUpAt: s.backedUpAt, backedUpFor: s.backedUpFor, idleMinutes: s.chosen ?? DEFAULT_IDLE_MINUTES };
  }

  function write(next: Stored): VaultPrefsData {
    const body = {
      backedUp: next.backedUp,
      backedUpAt: next.backedUpAt,
      ...(next.backedUpFor === null ? {} : { backedUpFor: next.backedUpFor }),
      ...(next.chosen === null ? {} : { idleMinutes: next.chosen, idleChosen: true }),
    };
    atomicWrite(file, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
    return view(next);
  }

  return {
    get: () => view(stored()),
    markBackedUp: (now = Date.now, wallet = null) =>
      write({ ...stored(), backedUp: true, backedUpAt: new Date(now()).toISOString(), backedUpFor: wallet === null ? null : wallet.toLowerCase() }),
    clearBackedUp: () => write({ ...stored(), backedUp: false, backedUpAt: null, backedUpFor: null }),
    setIdleMinutes(minutes) {
      const idle = IDLE_MINUTES_CHOICES.find((m) => m === minutes);
      if (idle === undefined) throw new Error(`idle minutes must be one of ${IDLE_MINUTES_CHOICES.join(', ')}`);
      return write({ ...stored(), chosen: idle });
    },
  };
}
