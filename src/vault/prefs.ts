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
//
// Phase 2 adds two more, written only once they are set. `chip`: the Touch ID key the vault
// moved to, for the vault account it moved, and when (src/vault/accounts.ts reads it against the
// chip service's marker). `allowance`: the size of the allowance in dollars, $100 until somebody
// picks. A chip entry this file cannot read still counts as one: the owner key stays out of the
// session (src/keystore/store.ts, keepOwnerKeyOutWhen) and the vault reads as broken, never as a
// vault that did not move.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { base58Decode } from '../chain/near.ts';
import { atomicWrite } from '../fsatomic.ts';

export const IDLE_MINUTES_CHOICES = [5, 15, 60] as const;
export type IdleMinutes = (typeof IDLE_MINUTES_CHOICES)[number];

// The window sits idle this long before the wallet locks, unless the person picked otherwise.
export const DEFAULT_IDLE_MINUTES: IdleMinutes = 5;
// What 0.10.12 and earlier wrote into the file when nobody had picked.
const OLD_DEFAULT_IDLE_MINUTES = 15;

// Karim's call 1 (Phase 2): the agent spends up to this much with no touch until somebody picks.
export const DEFAULT_ALLOWANCE_USD = 100;
// Not a policy, which is the allowance route's: a ceiling so the file cannot hold a nonsense size.
export const MAX_ALLOWANCE_USD = 1_000_000;

// The vault service's chip tag (PHASE2-PLAN.md C1): its prefix, an optional test label and an
// upper-case UUID, the form main.swift's validTag holds the vault tags to.
const CHIP_KEY_REF = /^chip:com\.karimbabasf\.phosphor\.chip\.(?:[a-z0-9-]{1,40}\.)?[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

/* The Touch ID key the vault moved to. `account` is the vault it moved, lower case: the entry
   speaks for that wallet alone, so another wallet opened with this data folder is not taken for
   a moved one. Empty strings are an entry this file holds and cannot read. */
export type ChipPrefs = { keyRef: string; publicKey: string; account: string; migratedAt: string };
export type AllowancePrefs = { sizeUsd: number };

export type VaultPrefsData = {
  backedUp: boolean;
  backedUpAt: string | null;
  // The wallet the proof was made for, its EVM address in lower case. Null when the proof was
  // written before proofs named their wallet, and such a proof stands as it always did.
  backedUpFor?: string | null;
  idleMinutes: IdleMinutes;
  chip: ChipPrefs | null;
  allowance: AllowancePrefs;
};

export type VaultPrefs = {
  get(): VaultPrefsData;
  markBackedUp(now?: () => number, wallet?: string | null): VaultPrefsData;
  clearBackedUp(): VaultPrefsData;
  setIdleMinutes(minutes: number): VaultPrefsData;
  // Null clears it. The rekey writes it once the views on chain say the move is done.
  setChip(chip: { keyRef: string; publicKey: string; account: string } | null, now?: () => number): VaultPrefsData;
  setAllowanceSize(usd: number): VaultPrefsData;
};

// What the file holds: the idle time and the allowance size only when they were picked.
type Stored = {
  backedUp: boolean;
  backedUpAt: string | null;
  backedUpFor: string | null;
  chosen: IdleMinutes | null;
  chip: ChipPrefs | null;
  allowanceUsd: number | null;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function chipFrom(raw: unknown): ChipPrefs | null {
  if (raw === undefined || raw === null) return null;
  const entry = typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return { keyRef: text(entry.keyRef), publicKey: text(entry.publicKey), account: text(entry.account).toLowerCase(), migratedAt: text(entry.migratedAt) };
}

function sizeOk(usd: unknown): usd is number {
  return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 && usd <= MAX_ALLOWANCE_USD;
}

/* "p256:" and the base58 of x || y, 64 bytes, a point on P-256: the public key the chip service
   answers (PHASE2-PLAN.md C1). Checked on the curve, so no string that is not a key gets pinned. */
export function isChipPublicKey(value: string): boolean {
  if (!value.startsWith('p256:')) return false;
  try {
    const raw = base58Decode(value.slice('p256:'.length));
    if (raw.length !== 64) return false;
    const x = Buffer.from(raw.subarray(0, 32)).toString('base64url');
    const y = Buffer.from(raw.subarray(32)).toString('base64url');
    crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x, y }, format: 'jwk' });
    return true;
  } catch {
    return false;
  }
}

export function createVaultPrefs(dataDir: string): VaultPrefs {
  const file = path.join(dataDir, 'vault.json');

  function stored(): Stored {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<VaultPrefsData> & { idleChosen?: unknown };
      const idle = IDLE_MINUTES_CHOICES.find((m) => m === raw.idleMinutes) ?? null;
      const picked = raw.idleChosen === true || idle !== OLD_DEFAULT_IDLE_MINUTES;
      const size = (raw.allowance as { sizeUsd?: unknown } | undefined)?.sizeUsd;
      return {
        backedUp: raw.backedUp === true,
        backedUpAt: typeof raw.backedUpAt === 'string' ? raw.backedUpAt : null,
        backedUpFor: typeof raw.backedUpFor === 'string' ? raw.backedUpFor.toLowerCase() : null,
        chosen: picked ? idle : null,
        chip: chipFrom(raw.chip),
        allowanceUsd: sizeOk(size) ? size : null,
      };
    } catch {
      return { backedUp: false, backedUpAt: null, backedUpFor: null, chosen: null, chip: null, allowanceUsd: null };
    }
  }

  function view(s: Stored): VaultPrefsData {
    return {
      backedUp: s.backedUp,
      backedUpAt: s.backedUpAt,
      backedUpFor: s.backedUpFor,
      idleMinutes: s.chosen ?? DEFAULT_IDLE_MINUTES,
      chip: s.chip,
      allowance: { sizeUsd: s.allowanceUsd ?? DEFAULT_ALLOWANCE_USD },
    };
  }

  function write(next: Stored): VaultPrefsData {
    const body = {
      backedUp: next.backedUp,
      backedUpAt: next.backedUpAt,
      ...(next.backedUpFor === null ? {} : { backedUpFor: next.backedUpFor }),
      ...(next.chosen === null ? {} : { idleMinutes: next.chosen, idleChosen: true }),
      ...(next.chip === null ? {} : { chip: next.chip }),
      ...(next.allowanceUsd === null ? {} : { allowance: { sizeUsd: next.allowanceUsd } }),
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
    setChip(chip, now = Date.now) {
      if (chip === null) return write({ ...stored(), chip: null });
      if (!CHIP_KEY_REF.test(chip.keyRef)) throw new Error('a chip key ref is chip:com.karimbabasf.phosphor.chip. then an optional label and an upper-case UUID');
      if (!isChipPublicKey(chip.publicKey)) throw new Error('a chip public key is p256: and the base58 of a P-256 point, 64 bytes');
      if (!/^0x[0-9a-fA-F]{40}$/.test(chip.account)) throw new Error('the vault account is a 0x address');
      const entry: ChipPrefs = { keyRef: chip.keyRef, publicKey: chip.publicKey, account: chip.account.toLowerCase(), migratedAt: new Date(now()).toISOString() };
      return write({ ...stored(), chip: entry });
    },
    setAllowanceSize(usd) {
      if (!sizeOk(usd)) throw new Error(`the allowance is a dollar amount from 0 to ${MAX_ALLOWANCE_USD}`);
      return write({ ...stored(), allowanceUsd: Math.round(usd * 100) / 100 });
    },
  };
}
