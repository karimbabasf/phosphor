// The live intents signer under each kind of wallet, for the rail tests (PHASE2-PLAN.md C6).
//
// A rail's harness signs for OWNER with its own throwaway TEST_KEY. useKind installs a stand-in
// keystore and the app's accounts so that the LIVE signer reaches that same key through the door
// its kind uses: the owner key under kind `key`, the allowance key under kind `chip`. The other
// door refuses (a moved vault's owner key answers owner_touch_required, and a wallet that has not
// moved never asks for its allowance key), and both doors count their asks, so a rail test proves
// which key signed and that it signed once. The real keystore and the real derivation are proved
// in tests/unit/rails-accounts.test.ts; this is the rail half.

import type { Address, Hex } from 'viem';
import { recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { base58Decode } from '../../../src/chain/near.ts';
import { useRailAccounts } from '../../../src/intents-sign.ts';
import { OwnerTouchRequired, useKeystore } from '../../../src/keystore/index.ts';
import type { Keystore } from '../../../src/keystore/index.ts';

export const KINDS = ['key', 'chip'] as const;
export type Kind = (typeof KINDS)[number];

// The vault a moved wallet keeps: deposits land there, and no rail signs for it.
export const MOVED_VAULT = '0x1111111111111111111111111111111111111111';

export type KindRun = { spend: Address; asks: { owner: number; allowance: number }; restore(): void };

export function useKind(kind: Kind, key: Hex): KindRun {
  const spend = privateKeyToAccount(key).address;
  const vault = kind === 'key' ? spend : MOVED_VAULT;
  const asks = { owner: 0, allowance: 0 };
  const store = {
    state: () => 'unlocked',
    isUnlocked: () => true,
    keyHeld: () => true,
    addresses: () => ({ evm: vault, solana: null, near: null, nearPublicKey: null }),
    keys: () => {
      throw new Error('a rail asked for the whole payload');
    },
    evmPrivateKey: () => {
      asks.owner += 1;
      if (kind === 'chip') throw new OwnerTouchRequired();
      return key;
    },
    allowanceKey: () => {
      asks.allowance += 1;
      if (kind === 'key') throw new Error('a wallet whose vault has not moved signs nothing with its allowance key');
      return Buffer.from(key.slice(2), 'hex');
    },
    derivedAccounts: () => (kind === 'chip' ? { allowance: spend, gas: '00'.repeat(32) } : null),
  } as unknown as Keystore;
  useKeystore(store);
  useRailAccounts(() => ({ kind, vault, spend }));
  return {
    spend,
    asks,
    restore() {
      useKeystore(null);
      useRailAccounts(null);
    },
  };
}

// Who signed: the address an erc191 signature field (`secp256k1:` + base58 of r || s || v) recovers to.
export async function signerOf(payload: string, field: string): Promise<Address> {
  const raw = base58Decode(field.replace(/^secp256k1:/, ''));
  const hex = `0x${Buffer.from(raw).toString('hex')}` as Hex;
  return recoverMessageAddress({ message: payload, signature: hex });
}
