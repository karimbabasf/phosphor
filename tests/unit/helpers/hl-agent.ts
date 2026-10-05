// A vault for the trading key tests (src/hl/agent-key.ts): tests/unit/helpers/owner-touch.ts's real
// keystore, relay and owner touch, plus vault.json's counter and the plan src/main.ts wires.

import { privateKeyToAccount } from 'viem/accounts';

import { hlAgentPlan } from '../../../src/hl/agent-key.ts';
import type { Keystore } from '../../../src/keystore/store.ts';
import { ownerTouchVia } from '../../../src/proposals/lifecycle.ts';
import { useOwnerTouch } from '../../../src/rails/hl-user-signed.ts';
import { createVaultPrefs } from '../../../src/vault/prefs.ts';
import type { VaultPrefs } from '../../../src/vault/prefs.ts';
import { chipVault } from './owner-touch.ts';
import type { ChipVault } from './owner-touch.ts';
import { tempDir } from './tmp.ts';

export type AgentVault = ChipVault & { prefs: VaultPrefs; prefsDir: string };

/* `moved: false` is a kind key wallet. `stored`: the wallet file also holds this API wallet, as one
   that approved a trading key with scripts/hl-agent.ts before it moved does; it is written while the
   wallet still holds its owner key, and the move (the gate and the owner touch) comes after.
   `keystore` hands the owner touch a wrapped keystore, as owner-touch.ts does (not with `stored`). */
export function agentVault(old: string, opts: { moved?: boolean; stored?: `0x${string}`; keystore?: (store: Keystore) => Keystore } = {}): AgentVault {
  const moved = opts.moved ?? true;
  const v = chipVault(old, { moved: opts.stored === undefined ? moved : false, keystore: opts.keystore });
  if (opts.stored !== undefined) {
    const stored = opts.stored;
    v.open();
    v.store.updatePayload((p) => ({ ...p, hyperliquidAgents: { mainnet: { privateKey: stored, address: privateKeyToAccount(stored).address } } }));
    v.store.lock();
    if (moved) {
      const gate = (vault: string): boolean => vault.toLowerCase() === v.vault.toLowerCase();
      v.store.keepOwnerKeyOutWhen(gate);
      useOwnerTouch(ownerTouchVia({ vault: v.relay, keystore: v.store, ownerOut: gate }));
    }
  }
  const prefsDir = tempDir('phosphor-hl-agent-');
  const prefs = createVaultPrefs(prefsDir);
  v.store.planHlAgentsWith((vault) => hlAgentPlan(prefs.get(), vault));
  return { ...v, prefs, prefsDir };
}
