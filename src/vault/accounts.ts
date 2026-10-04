// Which account does what, once a vault can move to the chip.
//
// Kind `key` is every wallet that has not moved, and it works exactly as 0.10.15 did: VAULT is the
// 0x account the owner key signs for, and every rail spends from it. Kind `chip` is a vault whose
// keys on chain are CHIP and RECOVERY: the owner key is out of the session
// (src/keystore/store.ts, keepOwnerKeyOutWhen), the rails spend from ALLOWANCE, and VAULT moves
// only behind a touch. Kind `broken` is vault.json saying this vault moved while the chip service
// shows no marker for that key naming it: vault signing stops and the window offers the restore.
// ALLOWANCE and GAS do not depend on the chip, so under `broken` the rails still spend from
// ALLOWANCE and the sweep still sends home.
//
// VAULT is always the wallet's own 0x address (addresses().evm), so invites, deposits and the
// Hyperliquid account land there whatever the kind. ALLOWANCE and GAS are the accounts of the keys
// the keystore derives (src/keystore/derived.ts), null until this process has opened the wallet.
// Never the marker's pinned allowance in their place: a pin is only believed once these keys are
// seen to give it, so no move is ever built for an allowance nobody checked.
//
// `chip` needs the service to have SAID so: until a status answer names the key, the kind reads
// `broken` with `checked` false, which a screen shows as a check under way and never as a loss.
// Nothing here is a control. vault.json is a file any process running as the owner can edit; what
// an edit changes is which key the rails reach for. It cannot reach CHIP, which signs only through
// the service, and the service checks its own marker before every signature.

import type { DerivedAccounts } from '../keystore/derived.ts';
import type { ChipPrefs, VaultPrefsData } from './prefs.ts';

export type AccountKind = 'key' | 'chip' | 'broken';

// chipStatus as the service answers it (PHASE2-PLAN.md C1).
export type ChipMarker = { account: string; allowance: string; recovery: string; at: string };
export type ChipStatus = {
  keychainHome: boolean;
  chips: { keyRef: string; publicKey: string; fresh: boolean; marker: ChipMarker | null }[];
};

export type Accounts = {
  kind: AccountKind;
  // Deposits, invites, the Hyperliquid account and every exit credit.
  vault: string | null;
  // What the rails sign for: VAULT under `key`, ALLOWANCE otherwise.
  spend: string | null;
  allowance: string | null;
  // The GAS account's NEAR implicit id, 64 hex characters.
  gas: string | null;
  chip: { keyRef: string; publicKey: string } | null;
  checked: boolean;
};

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a !== '' && a.toLowerCase() === b.toLowerCase();
}

/* The keystore's gate (src/main.ts wires it): the owner key stays out of the session while
   vault.json says this wallet's vault moved. An entry that names no account it can read keeps
   every wallet's key out, which fails shut. */
export function ownerKeyOut(prefs: { chip: ChipPrefs | null }, vault: string): boolean {
  const chip = prefs.chip;
  if (chip === null) return false;
  return chip.account === '' || same(chip.account, vault);
}

/* The rule, on its own. `status` is the last answer the service gave for `chip.keyRef`, or null
   when there is none yet. */
export function accountsFrom(input: { vault: string | null; derived: DerivedAccounts | null; chip: ChipPrefs | null; status: ChipStatus | null }): Accounts {
  const { vault, derived } = input;
  const chip = vault !== null && input.chip !== null && ownerKeyOut({ chip: input.chip }, vault) ? input.chip : null;
  const base = { vault, allowance: derived?.allowance ?? null, gas: derived?.gas ?? null };
  if (chip === null) return { kind: 'key', ...base, spend: vault, chip: null, checked: true };

  const entry = input.status?.chips.find((c) => c.keyRef === chip.keyRef) ?? null;
  const marker = entry?.marker ?? null;
  const holds =
    entry !== null &&
    marker !== null &&
    entry.publicKey === chip.publicKey &&
    same(marker.account, vault) &&
    // The allowance the marker pins is the one these keys derive, or this is not the vault it pinned.
    (derived === null || same(marker.allowance, derived.allowance));
  if (!holds) return { kind: 'broken', ...base, spend: base.allowance, chip: null, checked: input.status !== null };
  return { kind: 'chip', ...base, spend: base.allowance, chip: { keyRef: chip.keyRef, publicKey: chip.publicKey }, checked: true };
}

export type AccountsPort = {
  // From what is known now: never waits on the service.
  accounts(): Accounts;
  // Asks the service about the chip key vault.json names, then answers.
  refresh(): Promise<Accounts>;
};

/* `chipStatus` resolves only with a status the service read; a refusal or a dead transport
   rejects, and the last answer stands (none: unchecked). */
export function createAccounts(deps: {
  keystore: { addresses(): { evm: string | null }; derivedAccounts(): DerivedAccounts | null };
  prefs: { get(): Pick<VaultPrefsData, 'chip'> };
  chipStatus?: (keyRef: string) => Promise<ChipStatus>;
}): AccountsPort {
  let last: { keyRef: string; status: ChipStatus } | null = null;

  function accounts(): Accounts {
    const chip = deps.prefs.get().chip;
    const status = chip !== null && last !== null && last.keyRef === chip.keyRef ? last.status : null;
    return accountsFrom({ vault: deps.keystore.addresses().evm, derived: deps.keystore.derivedAccounts(), chip, status });
  }

  return {
    accounts,
    async refresh() {
      const chip = deps.prefs.get().chip;
      if (chip !== null && chip.keyRef !== '' && deps.chipStatus !== undefined) {
        try {
          last = { keyRef: chip.keyRef, status: await deps.chipStatus(chip.keyRef) };
        } catch {
          // Not an answer: whatever was known stays.
        }
      }
      return accounts();
    },
  };
}
